// Minimal ambient typing for the `unzipper` package (a real, direct dependency — see
// package.json — used ONLY to peek at the zip central directory's declared entry sizes
// before deciding whether to hand a .xlsx to exceljs; see xlsx.ts). `unzipper` ships no
// types of its own and there's no @types package; this covers exactly the surface used
// here, nothing more.
declare module 'unzipper' {
  interface UnzipperEntry {
    path: string;
    compressedSize: number;
    uncompressedSize: number;
  }
  interface UnzipperCentralDirectory {
    files: UnzipperEntry[];
  }
  const Open: {
    buffer(buf: Buffer): Promise<UnzipperCentralDirectory>;
  };
  export { Open };
}
