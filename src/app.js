require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { prisma } = require("./prisma");

const { createAuthRouter } = require("./routes/auth.routes");
const { createAttendanceRouter } = require("./routes/attendance.routes");
const { createEmployeesRouter } = require("./routes/employees.routes");
const { createDepartmentsRouter } = require("./routes/departments.routes");
const { createOrganizationsRouter } = require("./routes/organizations.routes");
const { createRolesRouter } = require("./routes/roles.routes");
const { createSettingsRouter } = require("./routes/settings.routes");
const { createDevicesRouter } = require("./routes/devices.routes");
const { createCoreHrRouter } = require("./routes/core-hr.routes");

const app = express();

app.set("trust proxy", true);

// Configure CORS
const configuredOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : null;

const allowedOrigins = configuredOrigins && configuredOrigins.length > 0
  ? configuredOrigins
  : [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes("*")) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Health check routes
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    name: "Enterprise HRMS API",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Mount /api prefixed routes
const apiRouter = express.Router();

apiRouter.use("/auth", createAuthRouter(prisma));
apiRouter.use("/attendance", createAttendanceRouter(prisma));
apiRouter.use("/employees", createEmployeesRouter(prisma));
apiRouter.use("/departments", createDepartmentsRouter(prisma));
apiRouter.use("/organizations", createOrganizationsRouter(prisma));
apiRouter.use("/roles", createRolesRouter(prisma));
apiRouter.use("/shifts", createSettingsRouter(prisma));
apiRouter.use("/devices", createDevicesRouter(prisma));
apiRouter.use("/core-hr", createCoreHrRouter(prisma));

app.use("/api", apiRouter);

// Global Error Handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled API Error:", err);
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal server error";
  res.status(status).json({ message, error: process.env.NODE_ENV === "development" ? err : undefined });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Enterprise HRMS Backend (Node.js/Express) live on port ${port}`);
  });
}

