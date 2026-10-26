const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createLoansRouter(prisma) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/loans (Admin/HR sees all, Employee sees own)
  router.get("/", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const isManager = req.user.role === "ADMIN" || req.user.role === "HR";

      const whereClause = isManager
        ? { organizationId }
        : { organizationId, userId: req.user.userId };

      const loans = await prisma.hrLoan.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
      });

      const userIds = [...new Set(loans.map((l) => l.userId).filter(Boolean))];
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              avatarUrl: true,
              department: { select: { name: true } },
            },
          })
        : [];
      const userMap = new Map(users.map((u) => [u.id, u]));

      const enriched = loans.map((l) => ({
        ...l,
        user: userMap.get(l.userId) || { fullName: "Employee", employeeId: "N/A" },
      }));

      return res.status(200).json(enriched);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/loans (Apply for HR Loan)
  router.post("/", async (req, res, next) => {
    try {
      const { loanType, principalAmount, tenureMonths, reason } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!principalAmount || !reason) {
        return res.status(400).json({ message: "Principal amount and reason are required." });
      }

      const principal = Number(principalAmount);
      const tenure = Math.max(1, Number(tenureMonths) || 12);
      const monthlyInstallment = Number((principal / tenure).toFixed(2));

      const created = await prisma.hrLoan.create({
        data: {
          organizationId,
          userId: req.user.userId,
          loanType: loanType || "EMERGENCY",
          principalAmount: principal,
          tenureMonths: tenure,
          monthlyInstallment,
          totalRepaid: 0,
          outstandingBalance: principal,
          reason: reason.trim(),
          status: "PENDING",
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/loans/:id/status (Admin/HR approves/rejects)
  router.patch("/:id/status", requireRoles("ADMIN", "HR"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};
      const organizationId = req.user.organizationId;

      const existing = await prisma.hrLoan.findFirst({
        where: { id, organizationId },
      });

      if (!existing) {
        return res.status(404).json({ message: "Loan application not found." });
      }

      const updated = await prisma.hrLoan.update({
        where: { id },
        data: {
          status: status || "APPROVED",
          approvedBy: req.user.userId,
        },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createLoansRouter };
