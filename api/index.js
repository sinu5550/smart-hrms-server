let app;
let initError = null;

try {
  app = require("../src/app");
} catch (err) {
  initError = err;
  console.error("CRITICAL: Failed to initialize application:", err);
}

module.exports = (req, res) => {
  if (initError || !app) {
    return res.status(500).json({
      error: "SERVER_INITIALIZATION_FAILED",
      message: initError ? initError.message : "Express application is unavailable",
      stack: process.env.NODE_ENV === "development" ? initError?.stack : undefined,
    });
  }
  return app(req, res);
};

