/**
 * What the pinned Ubuntu WSL rootfs (ELASTOS_ROOTFS_URL and
 * ELASTOS_ROOTFS_SHA256 in windowsHost.ts) puts in /root, /home and
 * /etc/skel, and the user its cloud-init makes on first boot
 * (etc/cloud/cloud.cfg `default_user: name: ubuntu`). Windows Uninstall
 * (windowsUninstall.ts) allows only these outside the data folder.
 *
 * Made from the pinned file with `node scripts/rootfs-manifest.js
 * <rootfs.tar.gz>`, which refuses a file with another SHA-256 and says
 * whether this constant still matches. A test fails when the pin changes
 * and this manifest does not.
 */
export interface RootfsFile {
  size: number;
  sha256: string;
}

export interface RootfsManifest {
  rootfsSha256: string;
  /** Regular files in /root, by name. */
  rootFiles: Record<string, RootfsFile>;
  /** Folders in /root. Each is empty in the rootfs. */
  rootDirs: string[];
  /** Entries in /home. */
  homeEntries: string[];
  /** /etc/skel, which `useradd -m` copies into the default user's home. */
  skel: Record<string, RootfsFile>;
  /** The user cloud-init makes on first boot. */
  defaultUser: string;
}

export const ROOTFS_MANIFEST: RootfsManifest = {
  rootfsSha256: '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea',
  rootFiles: {
    '.bashrc': {
      size: 3106,
      sha256: '34fbc467b8c624d92abcdf3edcf35ee46032618a6f23b210efab0e6824978126',
    },
    '.profile': {
      size: 161,
      sha256: 'bbee58b1e0787bb851e7f7a4d0c187a8122d68eb67e5fa464696310398ac005b',
    },
  },
  rootDirs: [
    '.ssh',
  ],
  homeEntries: [],
  skel: {
    '.bash_logout': {
      size: 220,
      sha256: '26882b79471c25f945c970f8233d8ce29d54e9d5eedcd2884f88affa84a18f56',
    },
    '.bashrc': {
      size: 3771,
      sha256: '342099da4dd28c394d3f8782d90d7465cb2eaa611193f8f378d6918261cb9bb8',
    },
    '.profile': {
      size: 807,
      sha256: '28b4a453b68dde64f814e94bab14ee651f4f162e15dd9920490aa1d49f05d2a4',
    },
  },
  defaultUser: 'ubuntu',
};
