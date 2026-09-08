function requireHumanSession(authService) {
  return (req, res, next) => {
    const session = authService.getRequestSession(req);
    if (!session) return res.status(401).json({ erro: "Sessão necessária." });
    req.humanUser = { username: session.username, role: session.role || "ADMIN" };
    return next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.humanUser || !roles.includes(req.humanUser.role)) return res.status(403).json({ erro: "Acesso não permitido." });
    return next();
  };
}

const requireAdmin = () => requireRole("ADMIN");

module.exports = { requireHumanSession, requireRole, requireAdmin };
