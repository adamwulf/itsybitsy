#!/bin/bash
set -u -o pipefail

# Deliberately independent of ib and its current layout. All discovery finishes
# before logging or any other write. Perl's core modules provide JSON, errno-aware
# stat, literal path replacement and atomic rewrites on macOS's stock bash 3.2.
perl - "$@" <<'PERL'
use strict;
use warnings;
use JSON::PP qw(decode_json);
use Cwd qw(abs_path getcwd);
use File::Basename qw(dirname basename);
use File::Path qw(make_path);
use File::Find ();
use File::Spec ();
use IPC::Open3;
use IO::Select;
use Symbol qw(gensym);
use POSIX qw(strftime);

# Usage: /bin/bash scripts/update-repos.sh [--apply] [REPO_PATH ...]
my $apply = 0;
my @requested;
for (@ARGV) {
    if ($_ eq '--help') { print "Usage: /bin/bash scripts/update-repos.sh [--apply] [REPO_PATH ...]\n"; exit 0 }
    elsif ($_ eq '--apply') { $apply = 1 }
    elsif (/^--/) { print STDERR "Unknown option: $_\n"; exit 2 }
    else { push @requested, $_ }
}
my $home = $ENV{HOME} // '';
if ($home !~ m{^/}) { print STDERR "HOME must be set and absolute\n"; exit 2 }
my $old = '.ittybitty';
my $new = '.itsybitsy';
my $lock_reason = 'update-repos.sh: repair failed';
my $log;
my @preflight_output;
my $errors = 0;
my $actions = 0;
my %counts = (migrate => 0, already => 0, none => 0, missing => 0);

sub say {
    my ($text) = @_;
    print "$text\n";
    if ($log) { print $log "$text\n" or die "write migration log: $!\n" }
    else { push @preflight_output, $text }
}
sub quote { my $s = shift; $s =~ s/'/'"'"'/g; return "'$s'" }
sub run {
    my @cmd = @_;
    my ($in, $out); my $err = gensym;
    my $pid = eval { open3($in, $out, $err, @cmd) };
    return (127, '', "$@") if !$pid;
    close $in;
    my $select = IO::Select->new($out, $err);
    my ($stdout, $stderr) = ('', '');
    my $outfd = fileno($out);
    while (my @ready = $select->can_read) {
        for my $fh (@ready) {
            my $n = sysread($fh, my $buffer, 65536);
            die "read command output: $!\n" unless defined $n;
            if (!$n) { $select->remove($fh); close $fh; next }
            if (fileno($fh) == $outfd) { $stdout .= $buffer } else { $stderr .= $buffer }
        }
    }
    waitpid($pid, 0);
    return ($? == -1 ? 127 : ($? & 127 ? 128 + ($? & 127) : $? >> 8), $stdout, $stderr);
}
sub git_read { my ($repo, @args) = @_; return run('git', '--no-optional-locks', '-C', $repo, @args) }
sub git_write { my ($repo, @args) = @_; return run('git', '-C', $repo, @args) }
sub read_file {
    my ($file) = @_;
    open my $fh, '<', $file or die "read " . quote($file) . ": $!\n";
    local $/; my $body = <$fh>;
    close $fh or die "close " . quote($file) . ": $!\n";
    return $body // '';
}
sub exists_checked {
    my ($path) = @_;
    return 1 if lstat($path);
    return 0 if $!{ENOENT};
    die "lstat " . quote($path) . ": $!\n";
}
sub children {
    my ($path) = @_;
    return () unless exists_checked($path);
    opendir my $dh, $path or die "opendir " . quote($path) . ": $!\n";
    my @names = sort grep { $_ ne '.' && $_ ne '..' } readdir $dh;
    closedir $dh or die "closedir " . quote($path) . ": $!\n";
    return map { "$path/$_" } @names;
}
sub plain_directory {
    my ($path) = @_;
    return 0 unless exists_checked($path);
    return -d _ && !-l _;
}
sub action {
    my ($message, $fn) = @_;
    say('  ' . ($apply ? '' : 'would ') . $message);
    $actions++;
    $fn->() if $apply;
}
sub atomic_write {
    my ($file, $body) = @_;
    my $mode = 0644;
    if (exists_checked($file)) {
        my @stat = stat($file);
        die "stat " . quote($file) . ": $!\n" unless @stat;
        $mode = $stat[2] & 07777;
    }
    make_path(dirname($file));
    my $tmp = dirname($file) . '/.' . basename($file) . '.update-repos-tmp';
    # Remove an interrupted temporary file before opening, including a symlink.
    unlink($tmp) or die "unlink " . quote($tmp) . ": $!\n" if exists_checked($tmp);
    open my $fh, '>', $tmp or die "write " . quote($tmp) . ": $!\n";
    print $fh $body or die "write " . quote($tmp) . ": $!\n";
    close $fh or die "close " . quote($tmp) . ": $!\n";
    chmod($mode, $tmp) or die "chmod " . quote($tmp) . ": $!\n";
    rename($tmp, $file) or die "rename " . quote($tmp) . ": $!\n";
}
sub rewrite {
    my ($file, $transform, $description) = @_;
    return unless exists_checked($file);
    my $before = read_file($file);
    my $after = $transform->($before);
    if ($before eq $after) { discard_stale_temp($file); return }
    action("rewrite $description " . quote($file), sub { atomic_write($file, $after) });
}
sub discard_stale_temp {
    my ($file) = @_;
    my $tmp = dirname($file) . '/.' . basename($file) . '.update-repos-tmp';
    return unless exists_checked($tmp);
    action('remove interrupted temporary file ' . quote($tmp), sub { unlink($tmp) or die "unlink " . quote($tmp) . ": $!\n" });
}
sub advice {
    my ($given) = @_;
    say("  Keep this repo registered. Until it is migrated, don't press f on it in ib watch, and don't spawn, ask or rehire there. Fix the cause and re-run /bin/bash scripts/update-repos.sh --apply " . quote($given));
}
sub error {
    my ($message) = @_;
    $message =~ s/\n$//;
    say("  ERROR $message"); $errors++;
}
sub later_step {
    my ($fn) = @_;
    eval { $fn->(); 1 } or error($@);
}
sub under { my ($path, $root) = @_; return index($path, "$root/") == 0 }
sub real_equal {
    my ($a, $b) = @_;
    my ($ra, $rb) = (abs_path($a), abs_path($b));
    return defined($ra) && defined($rb) && $ra eq $rb;
}
sub path_forms {
    my ($given, $root) = @_;
    my %seen;
    return grep { !$seen{$_}++ } ($given, File::Spec->canonpath($given), $root, abs_path($given) // $given, abs_path($root) // $root);
}

say('update-repos.sh — ' . ($apply ? 'APPLY' : 'DRY RUN (add --apply to change anything)'));
my @blockers;
push @blockers, 'Run from a plain terminal outside a runtime dir' if getcwd() =~ m{/\.ittybitty/|/\.itsybitsy/agents/};
my ($gv, $version, $ge) = run('git', '--version');
push @blockers, 'Install git 2.31 or later' if $gv || $version !~ /git version (\d+)\.(\d+)/ || ($1 < 2 || ($1 == 2 && $2 < 31));
my ($pv) = run('perl', '-MJSON::PP', '-e1');
push @blockers, 'Install perl with core JSON::PP' if $pv;
if (!@requested) {
    eval {
        my $registry = decode_json(read_file("$home/.itsybitsy/repos.json"));
        die "repos.json must contain a repos array\n" unless ref($registry) eq 'HASH' && ref($registry->{repos}) eq 'ARRAY';
        for my $entry (@{$registry->{repos}}) {
            die "invalid repo path in repos.json\n" unless ref($entry) eq 'HASH' && defined($entry->{path}) && !ref($entry->{path}) && length($entry->{path});
            push @requested, $entry->{path};
        }
        1;
    } or push @blockers, "Read registry: $@";
}
my ($tmux_rc, $sessions, $tmux_err) = run('tmux', 'list-sessions', '-F', '#{session_name}');
if ($tmux_rc && "$sessions$tmux_err" !~ /no server running|error connecting to/) {
    push @blockers, "tmux failed: $tmux_err$sessions";
} elsif (!$tmux_rc) {
    for (split /\n/, $sessions) {
        push @blockers, "tmux session $_: press P on agents in ib watch, then quit it" if /^(?:ittybitty-|itsybitsy-)/ || $_ eq 'ib-coordinator';
    }
}
my ($ps_rc, $processes, $ps_err) = run('ps', '-Ao', 'pid=,args=');
push @blockers, "ps failed: $ps_err" if $ps_rc;
for (split /\n/, $processes) {
    if (/^\s*(\d+)\s+(\S+)/ && basename($2) eq 'ib') {
        push @blockers, "ib process $1: quit ib watch; wait for watchdogs; stop leftover proxy/collector with kill $1";
    }
}

# Resolve and stat targets read-only; errors are per-repo, not global blockers.
my @repos;
my %seen;
for my $given (@requested) {
    my $r = { given => $given };
    eval {
        if (!exists_checked($given)) { $r->{missing} = 1; return_from_classification() }
        die "not a directory: " . quote($given) . "\n" unless -d $given;
        exists_checked("$given/$old");
        exists_checked("$given/$new");
        my ($rc, $top, $err) = git_read($given, 'rev-parse', '--show-toplevel');
        $top =~ s/\n$//;
        if ($rc && $err !~ /not a git repository/) { die "git rev-parse: $err\n" }
        $r->{git} = !$rc;
        $r->{root} = $rc ? $given : $top;
        $r->{forms} = [path_forms($given, $r->{root})];
        $r->{home} = real_equal($given, $home) || real_equal($r->{root}, $home);
        $r->{old} = exists_checked("$r->{root}/$old");
        $r->{new} = exists_checked("$r->{root}/$new");
        if (!$r->{git} && $r->{old}) {
            for my $a (children("$r->{root}/$old/agents")) {
                next unless plain_directory($a);
                die "worktree .git exists but repo is not a git repository\n" if exists_checked("$a/repo/.git");
            }
        }
        if ($r->{git}) {
            my ($rc, $common, $err) = git_read($r->{root}, 'rev-parse', '--path-format=absolute', '--git-common-dir');
            die "git common-dir: $err\n" if $rc;
            $common =~ s/\n$//; $r->{common} = $common;
        }
        1;
    } or do { $r->{error} = $@ unless $r->{missing} };
    my $key = abs_path($r->{root} // $given) // $given;
    next if $seen{$key}++;
    push @repos, $r;
}
sub return_from_classification { die "missing\n" }
my ($lsof_rc, $cwds, $lsof_err) = run('lsof', '-a', '-u', "$<", '-d', 'cwd', '-Fpn');
push @blockers, "lsof failed: $lsof_err" if $lsof_rc;
my $pid = '?';
for (split /\n/, $cwds) {
    $pid = $1 if /^p(\d+)/;
    next unless /^n(.*)/;
    my $cwd = $1;
    for my $r (@repos) {
        for my $form (@{$r->{forms} // [$r->{given}, abs_path($r->{given}) // $r->{given}]}) {
            if ($cwd eq "$form/$old" || $cwd eq "$form/$new" || under($cwd, "$form/$old") || under($cwd, "$form/$new")) {
                push @blockers, "pid $pid cwd " . quote($cwd) . ': close that terminal or agent session';
            }
        }
    }
}
if (@blockers) { say("BLOCKER: $_") for @blockers; exit 2 }
say('Preflight: ok (no agent tmux sessions, no ib processes, no cwd under a runtime dir)');
if ($apply) {
    eval {
        my $dir = "$home/.itsybitsy/migrations";
        make_path($dir);
        my $file = "$dir/update-repos-" . strftime('%Y%m%d-%H%M%S', localtime) . '.log';
        open $log, '>>', $file or die "open log " . quote($file) . ": $!\n";
        print $log join("\n", @preflight_output) . "\n" or die "write migration log: $!\n";
        say('Log: ' . quote($file));
        1;
    } or do { print STDERR "ERROR $@"; exit 1 };
}

sub replace_paths {
    my ($text, $r) = @_;
    for my $form (@{$r->{forms}}) { $text =~ s{\Q$form/$old/\E}{$form/$new/}g }
    return $text;
}
sub repaired {
    my ($r, $admin, $worktree) = @_;
    return 0 unless exists_checked("$worktree/.git");
    my ($rc, $top) = git_read($worktree, 'rev-parse', '--show-toplevel');
    $top =~ s/\n$//;
    my $back = read_file("$admin/gitdir"); $back =~ s/\n$//;
    $back = File::Spec->rel2abs($back, $admin) unless $back =~ m{^/};
    return !$rc && real_equal($top, $worktree) && real_equal($back, "$worktree/.git");
}
sub failed_repair {
    my ($r, $admin, $recorded, $worktree, $detail, $relative) = @_;
    my $given = quote($r->{given});
    if ($apply && !exists_checked("$admin/locked")) {
        my ($rc, $out, $err) = git_write($r->{root}, 'worktree', 'lock', '--reason', $lock_reason, $recorded);
        if ($rc && !exists_checked("$admin/locked")) {
            if ($relative) {
                # Older Git cannot address an entry with a relative gitdir.
                # Protect precisely this known admin entry without repairing it.
                atomic_write("$admin/locked", "$lock_reason\n");
                say('  wrote protective lock marker (Git cannot address relative gitdir)');
            } else { error("lock failed: $out$err") }
        }
    }
    say('  ' . ($apply ? '' : 'would lock; ') . 'repair failed: ' . $detail);
    say('  admin entry: ' . quote($admin) . '; gitdir: ' . quote(read_file("$admin/gitdir")));
    say('  cat ' . quote("$worktree/.git") . ': ' . (exists_checked("$worktree/.git") ? read_file("$worktree/.git") : '(missing)'));
    say("  Manual repair: git -C $given worktree repair " . quote($worktree));
    say("  Then re-run /bin/bash scripts/update-repos.sh --apply $given; manual unlock: git -C $given worktree unlock " . quote($worktree));
    error('repair remains unresolved; entry left in place' . ($apply && exists_checked("$admin/locked") ? ' and locked' : ''));
}
sub repair_worktrees {
    my ($r) = @_;
    for my $admin (children("$r->{common}/worktrees")) {
      later_step(sub {
        return unless plain_directory($admin);
        return unless exists_checked("$admin/gitdir");
        my $recorded = read_file("$admin/gitdir"); $recorded =~ s/\n$//;
        my $relative = $recorded !~ m{^/};
        my $absolute = $relative ? File::Spec->rel2abs($recorded, $admin) : $recorded;
        # abs_path cannot resolve a moved-away leaf; collapse lexical .. instead.
        my @parts;
        for my $part (split m{/}, $absolute) {
            next if $part eq '' || $part eq '.';
            if ($part eq '..') { pop @parts } else { push @parts, $part }
        }
        $absolute = '/' . join('/', @parts);
        my $mapped = replace_paths($absolute, $r);
        my $is_old = $mapped ne $absolute;
        my $own_lock = 0;
        if (exists_checked("$admin/locked")) {
            my $reason = read_file("$admin/locked"); $reason =~ s/\n$//;
            $own_lock = $reason eq $lock_reason;
        }
        my $is_new = grep { under($absolute, "$_/$new") } @{$r->{forms}};
        return unless $is_old || ($own_lock && $is_new);
        my $worktree = dirname($mapped);
        if ($relative && $is_old) { failed_repair($r, $admin, dirname($recorded), $worktree, 'relative gitdir under OLD is unsupported', 1); return }
        if ($own_lock) {
            if (!$is_old && repaired($r, $admin, $worktree)) {
                action('unlock (repaired by hand): git -C ' . quote($r->{given}) . ' worktree unlock ' . quote($worktree), sub {
                    my ($rc, $out, $err) = git_write($r->{root}, 'worktree', 'unlock', $worktree);
                    die "unlock: $out$err\n" if $rc;
                    say('  unlocked (repaired by hand)');
                });
            } else { failed_repair($r, $admin, dirname($absolute), $worktree, 'previous repair failure still unresolved') }
            return;
        }
        # During a dry run the source tree has not moved yet.
        my $inspect = !$apply && $r->{old} ? dirname($absolute) : $worktree;
        if (!exists_checked("$inspect/.git")) { say('  warn stale entry, left in place: ' . quote($absolute)); return }
        action('repair worktree for ' . quote($r->{given}) . ': ' . quote($worktree), sub {
            my ($rc, $out, $err) = git_write($r->{root}, 'worktree', 'repair', $worktree);
            say('  git repair context: ' . "$out$err") if length("$out$err");
            # repair also scans unrelated entries; its exit code cannot tell
            # whether this particular worktree was repaired.
            failed_repair($r, $admin, dirname($absolute), $worktree, "$out$err") unless repaired($r, $admin, $worktree);
        });
      });
    }
}

for my $r (@repos) {
    my $given = $r->{given};
    say('[' . basename($given) . '] ' . quote($given));
    if ($r->{missing}) { $counts{missing}++; say('  missing — skipped'); advice($given); next }
    if ($r->{error}) { error($r->{error}); advice($given); next }
    if ($r->{home}) { error('repo is $HOME; ib remove ' . quote($given) . ' before the deploy'); next }
    my $root = $r->{root};
    if ($r->{old} && $r->{new}) {
        later_step(sub {
            my @files;
            local $SIG{__WARN__} = sub { die @_ };
            File::Find::find({ no_chdir => 1, wanted => sub { push @files, $File::Find::name unless -d $_ && !-l $_ } }, "$root/$new");
            error('both .ittybitty and .itsybitsy exist');
            if (!grep { $_ ne "$root/$new/repo-id" } @files) {
                say("  NEW holds only repo-id and empty dirs; keep OLD's repo-id, remove NEW: rm -rf " . quote("$root/$new") . '; re-run /bin/bash scripts/update-repos.sh --apply ' . quote($given));
            } else {
                my @a = children("$root/$new/agents"); my @b = children("$root/$new/archive"); my @c = children("$root/$new/prompts");
                say('  NEW holds ' . scalar(@a) . ' agents, ' . scalar(@b) . ' archives, ' . scalar(@c) . ' prompts; user-questions.json: ' . (exists_checked("$root/$new/user-questions.json") ? 'yes' : 'no'));
                say("  (1) Keep OLD's repo-id.");
                say('  (2) Keep the repo registered. With ib watch quit and no f, use the new ib CLI to merge or retire every agent under NEW. Their archives will not be rehirable with the retained repo-id.');
                say('  (3) Set aside NEW prompts/ and user-questions.json, then rm -rf ' . quote("$root/$new") . '; run /bin/bash scripts/update-repos.sh --apply ' . quote($given) . '; copy back what is still needed.');
            }
        });
        advice($given); next;
    }
    if ($r->{old} && -l "$root/$old") { error('OLD is a symlink — skipped'); advice($given); next }
    if (!$r->{old} && !$r->{new}) { $counts{none}++; say('  no runtime dir — skipped'); next }
    $r->{old} ? $counts{migrate}++ : $counts{already}++;
    my $before_actions = $actions;
    my $before_errors = $errors;
    my $tracked = '';
    # Steps 1 and 2 abort this repo on failure. Later failures continue.
    my $moved = eval {
        if ($r->{git}) {
            my ($rc, $out, $err) = git_read($root, 'ls-files', '--', $old);
            die "git ls-files: $err\n" if $rc;
            $tracked = $out;
            my $exclude = "$r->{common}/info/exclude";
            my $body = exists_checked($exclude) ? read_file($exclude) : '';
            my @missing = grep { $body !~ /^\Q$_\E$/m } ('.itsybitsy/', '.agents/rules/itsybitsy-agent.md');
            if (@missing) {
                $body .= "\n" if length($body) && $body !~ /\n$/;
                $body .= "# added by itsybitsy scripts/update-repos.sh\n" . join("\n", @missing) . "\n";
                action('append ' . scalar(@missing) . ' lines to info/exclude for ' . quote($given), sub { atomic_write($exclude, $body) });
            } else { discard_stale_temp($exclude) }
        }
        if ($r->{old}) {
            action('mv .ittybitty -> .itsybitsy for ' . quote($given), sub {
                my ($rc, $out, $err) = run('mv', "$root/$old", "$root/$new");
                die "move failed: $out$err\n" if $rc;
            });
        }
        1;
    };
    if (!$moved) { error($@); advice($given); next }
    my $runtime = !$apply && $r->{old} ? "$root/$old" : "$root/$new";
    later_step(sub { repair_worktrees($r) }) if $r->{git};
    if ($r->{git} && -d "$r->{common}/worktrees") {
        later_step(sub {
            my ($rc, $files, $err) = run('find', "$r->{common}/worktrees", '-path', '*/modules/*', '-type', 'f', '-name', 'config', '-print0');
            die "find submodules: $err\n" if $rc;
            for my $file (split /\0/, $files) {
              my $inside = substr($file, length("$r->{common}/worktrees/"));
              my (undef, $module_path) = split m{/modules/}, $inside, 2;
              next unless defined $module_path;
              later_step(sub {
                return unless -e (dirname($file) . '/HEAD');
                my ($rc, $value, $err) = git_read($root, 'config', '--file', $file, '--get', 'core.worktree');
                return if $rc == 1;
                die "read submodule config: $err\n" if $rc;
                $value =~ s/\n$//;
                my $updated = $value; $updated =~ s{/\.ittybitty/agents/}{/.itsybitsy/agents/}g;
                return if $updated eq $value;
                action('rewrite submodule core.worktree ' . quote($file), sub {
                    my ($rc, $out, $err) = git_write($root, 'config', '--file', $file, 'core.worktree', $updated);
                    die "write submodule config: $out$err\n" if $rc;
                });
              });
            }
        });
    }
    later_step(sub {
        my @agents = children("$runtime/agents");
        my @dirs = (@agents, children("$runtime/archive"));
        for my $a (@agents) {
            later_step(sub { push @dirs, "$a/.retirement/runtime" if plain_directory($a) });
        }
        my %active = map { $_ => 1 } @agents;
        for my $d (@dirs) {
          later_step(sub {
            return unless plain_directory($d);
            my $meta;
            if (exists_checked("$d/meta.json")) {
                my $body = read_file("$d/meta.json");
                eval {
                    $meta = decode_json($body);
                    die "expected an object\n" unless ref($meta) eq 'HASH';
                    1;
                } or do { error('malformed meta.json ' . quote("$d/meta.json") . ": $@; skipping dir"); return };
            }
            later_step(sub { rewrite("$d/meta.json", sub { my $s = shift; $s =~ s/("tmux_session"\s*:\s*")ittybitty-/${1}itsybitsy-/g; $s }, 'tmux_session') });
            for my $file ('start.sh', 'resume.sh', 'settings.local.json', '.claude/settings.local.json') {
                later_step(sub { rewrite("$d/$file", sub { replace_paths(shift, $r) }, 'paths') });
            }
            later_step(sub {
              if ($meta) {
                my $json = JSON::PP->new->encode([$meta->{paths}, $meta->{sandbox}]);
                say('  warn sealed paths/sandbox still contains OLD; after deploy run ib sandbox refresh ' . quote($meta->{id} // basename($d))) if $json =~ m{/\.ittybitty/};
              }
            });
            return unless $active{$d};
            my $a = $d;
            later_step(sub { rewrite("$a/repo/.claude/settings.local.json", sub { replace_paths(shift, $r) }, 'paths') });
            later_step(sub {
                my $rules = "$a/repo/.agents/rules";
                if (exists_checked("$rules/ittybitty-agent.md")) {
                    my ($rc, $out, $err) = git_read("$a/repo", 'ls-files', '--', '.agents/rules/ittybitty-agent.md');
                    die "check tracked agy rule: $err\n" if $rc;
                    if (!length($out)) {
                        action('rename agy rule ' . quote("$rules/ittybitty-agent.md"), sub {
                            if (exists_checked("$rules/itsybitsy-agent.md")) { unlink("$rules/ittybitty-agent.md") or die "remove duplicate rule: $!\n" }
                            else { rename("$rules/ittybitty-agent.md", "$rules/itsybitsy-agent.md") or die "rename agy rule: $!\n" }
                        });
                    }
                }
                rewrite("$a/repo/.agents/hooks.json", sub { my $s = shift; $s =~ s/"ittybitty"(\s*:)/"itsybitsy"$1/g; $s }, 'agy hook key');
            });
          });
        }
    });
    later_step(sub {
        my %done;
        for my $form (@{$r->{forms}}) {
            my $enc = $form; $enc =~ s/[^A-Za-z0-9]/-/g;
            for my $dir (children("$home/.claude/projects")) {
                my $name = basename($dir);
                next unless index($name, "$enc--ittybitty-agents-") == 0;
                next if $done{$dir}++;
                my $next_name = $name; $next_name =~ s/^\Q$enc--ittybitty-agents-\E/$enc--itsybitsy-agents-/;
                my $target = dirname($dir) . "/$next_name";
                if (length($name) > 200 || length($next_name) > 200) { say('  warn transcript name over 200 characters — skipped: ' . quote($dir)); next }
                if (exists_checked($target)) { say('  warn transcript target exists — skipped: ' . quote($target)); next }
                action('rename Claude transcript ' . quote($dir) . ' -> ' . quote($target), sub { rename($dir, $target) or die "rename transcript: $!\n" });
            }
        }
    });
    later_step(sub {
        my ($rc, $links, $err) = run('find', $runtime, '-type', 'l', '-lname', '*/.ittybitty/*', '-print');
        die "find symlinks: $err\n" if $rc;
        say("  warn symlinks still naming OLD:\n$links") if length($links);
        for my $file ("$root/.gitignore", grep { /\/settings[^\/]*\.json$/ } children("$root/.claude")) {
            next unless exists_checked($file);
            say('  warn OLD in ' . quote($file)) if read_file($file) =~ m{/\.ittybitty|\.ittybitty/};
        }
        if (length($tracked)) {
            say('  warn tracked file inside OLD; after the move run: git -C ' . quote($root) . ' rm -r --cached .ittybitty');
            say('  then commit. Until then ib refuses to spawn in this repo.');
        }
    });
    say('  already migrated — nothing to do') if !$r->{old} && $before_actions == $actions && $before_errors == $errors;
}
say('User-wide');
later_step(sub {
    my @rewrite;
    for my $file (children("$home/.itsybitsy/agent-types")) {
        next unless $file =~ /\.md$/;
        if (read_file($file) =~ /IttyBitty|ittybitty/) { push @rewrite, $file }
        else { discard_stale_temp($file) }
    }
    say('  ' . ($apply ? 'rewrite ' : 'would rewrite ') . scalar(@rewrite) . ' files in ~/.itsybitsy/agent-types');
    for my $file (@rewrite) {
        later_step(sub { rewrite($file, sub { my $s = shift; $s =~ s/IttyBitty/ItsyBitsy/g; $s =~ s/ittybitty/itsybitsy/g; $s }, 'agent-type prose') });
    }
    for my $a (children("$home/.itsybitsy/agents")) {
        next unless plain_directory($a);
        my $queue = "$a/outbox.jsonl";
        next unless exists_checked($queue);
        say('  warn queued message still mentions OLD: ' . quote($queue)) if read_file($queue) =~ m{/\.ittybitty/};
    }
});
say("Summary: $counts{migrate} to migrate, $counts{already} already migrated, $counts{none} no runtime dir, $counts{missing} missing, $errors errors");
say('DRY RUN — nothing was changed.') unless $apply;
close $log or die "close migration log: $!\n" if $log;
exit($errors ? 1 : 0);
PERL
