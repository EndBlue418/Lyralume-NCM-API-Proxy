// Static corresponding source only: never reads environment variables or user data.
const source = require('./source-bundle.json');
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json(source);
};
