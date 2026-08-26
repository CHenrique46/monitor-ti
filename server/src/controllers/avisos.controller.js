const avisosService = require("../services/avisos.service");

async function criar(req, res) {
  try {
    const r = await avisosService.criarAviso(req.body);
    return res.status(201).json(r);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }
}

async function listar(req, res) {
  try {
    return res.status(200).json(await avisosService.listarAvisos());
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}

async function listarAgendamentos(req, res) {
  try {
    return res.status(200).json(await avisosService.listarAgendamentos());
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}

async function atualizarAgendamento(req, res) {
  try {
    const r = await avisosService.atualizarAgendamento(Number(req.params.id), req.body);
    return res.status(200).json(r);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }
}

async function excluirAgendamento(req, res) {
  try {
    await avisosService.excluirAgendamento(Number(req.params.id));
    return res.status(204).end();
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }
}

async function enviarAgora(req, res) {
  try {
    const r = await avisosService.enviarAvisoExistente(Number(req.params.id), req.body || {});
    return res.status(201).json(r);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }
}

async function historico(req, res) {
  try {
    return res.status(200).json(await avisosService.obterEntregas(req.query));
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}

module.exports = {
  criar,
  listar,
  listarAgendamentos,
  atualizarAgendamento,
  excluirAgendamento,
  enviarAgora,
  historico
};
