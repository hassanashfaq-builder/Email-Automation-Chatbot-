const google = require('./google');
const zoho = require('./zoho');

const providers = { google, zoho };

function get(providerName) {
  const provider = providers[providerName];
  if (!provider) throw new Error(`Unknown mailer provider: ${providerName}`);
  return provider;
}

module.exports = { providers, get };
