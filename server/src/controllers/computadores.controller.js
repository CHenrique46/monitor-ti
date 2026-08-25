const computadoresService = require("../services/computadores.service");

async function list(req, res) {
  try {
    const items = await computadoresService.list();
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

module.exports = { list };
