/**
 * This build's version, from package.json. The import is bundled into the
 * compiled `ib` binary, so it does not depend on a package.json beside it at
 * run time.
 */
import packageJson from "../package.json" with { type: "json" };

export const IB_VERSION: string = packageJson.version;
