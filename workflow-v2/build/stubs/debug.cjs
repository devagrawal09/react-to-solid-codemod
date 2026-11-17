// Babel logs through `debug`; nothing here reads those logs.
function createDebug() { const log = () => {}; log.enabled = false; log.extend = createDebug; return log; }
createDebug.enable = () => {}; createDebug.disable = () => ""; createDebug.enabled = () => false;
module.exports = createDebug; module.exports.default = createDebug;
