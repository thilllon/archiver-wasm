// The upstream test decrypts with aes-js and relies on the little-endian counter patch that
// upstream's library applied globally when required (aes-hmac-etm-stream.js:16-25, N7).
const aes = require('aes-js');
aes.Counter.prototype.increment = function () {
  for (var i = 0; i < 16; i++) {
    if (this._counter[i] === 255) { this._counter[i] = 0; } else { this._counter[i]++; break; }
  }
};
module.exports = require('../../../../../cjs/index.cjs').AesHmacEtmStream;
