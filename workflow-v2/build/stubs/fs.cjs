// Babel only touches fs to load config files; this pass passes configFile:false and babelrc:false.
const no = (name) => () => { throw new Error(`fs.${name} is not available in this bundle`); };
module.exports = { readFileSync: no("readFileSync"), existsSync: () => false, statSync: no("statSync"), readFile: no("readFile"), stat: no("stat"), readdirSync: () => [] };
