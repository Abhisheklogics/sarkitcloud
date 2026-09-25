const crypto = require('crypto');

module.exports = function generateApiKey() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
};
