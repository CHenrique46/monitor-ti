const healthService = require("../services/health.service");

async function getHealth(req, res) {
  try {
    const result = await healthService.check();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

module.exports = { getHealth };
