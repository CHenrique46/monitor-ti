function requireHumanSession(authService) {
  return (req, res, next) => {
    const session = authService.getRequestSession(req);
    if (!session) return res.status(401).json({ erro: "Sessão necessária." });
    req.humanUser = { username: session.username };
    return next();
  };
}

module.exports = { requireHumanSession };
