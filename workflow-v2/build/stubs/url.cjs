module.exports = { fileURLToPath: (u) => String(u).replace(/^file:\/\//, ""), pathToFileURL: (p) => new URL("file://" + p) };
