// Shared bd discovery and child-tool PATH candidates for GUI launches.
import { homedir } from "os"
import { join } from "path"

/** Version-manager directories precede system installs during automatic discovery. */
export const VERSION_MANAGER_DIRS = [
  ...(process.env.MISE_DATA_DIR ? [join(process.env.MISE_DATA_DIR, "shims")] : []),
  ...(process.env.XDG_DATA_HOME ? [join(process.env.XDG_DATA_HOME, "mise/shims")] : []),
  join(homedir(), ".local/share/mise/shims"),
  ...(process.env.ASDF_DATA_DIR ? [join(process.env.ASDF_DATA_DIR, "shims")] : []),
  join(homedir(), ".asdf/shims"),
  join(homedir(), ".nix-profile/bin"),
  join(homedir(), ".local/state/nix/profiles/profile/bin"),
  ...(process.env.USER ? [join("/etc/profiles/per-user", process.env.USER, "bin")] : []),
  ...(process.env.USER
    ? [join("/nix/var/nix/profiles/per-user", process.env.USER, "profile/bin")]
    : []),
  "/nix/var/nix/profiles/default/bin",
]
