// src/controllers/caseController.js
import { v4 as uuidv4 } from "uuid";
import {
  createTraveller,
  createCase,
  getCasesByAgentIds,
  getCasesWithoutSalesByAgentIds,
  updateCaseStatus,
  getAllCasesWithPagination,
  getCasesByAgentIdsWithPagination,
  updateCaseAndTraveller,
  getCaseDetailsById
} from "../models/caseModel.js";
import { getAgentVisibilityIds } from "../models/userModel.js";
import { createSale, getSaleByCaseId, incrementPolicyEditCount } from "../models/salesModel.js";
import { logActivity } from "../models/activityModel.js"; // <-- make sure this exists
import { INVALID_DATE_OF_BIRTH_CODE } from "../utils/parseFlexibleDate.js";
import {
  operatorLimitedEditOpen,
  inLast24HoursBeforeDeparture,
  hasDeparted,
  MAX_OPERATOR_POLICY_EDITS
} from "../utils/policyEditRules.js";

const MAX_GROUP_MEMBERS = 500;

async function assertUserCanAccessCase(req, caseId) {
  const row = await getCaseDetailsById(caseId);
  if (!row) return { error: 404, message: "Case not found" };
  if (req.user.role === "admin") return { caseRow: row };
  const ids = await getAgentVisibilityIds(req.user.id);
  if (!ids.includes(row.created_by)) return { error: 403, message: "Forbidden" };
  return { caseRow: row };
}

function normalizeDestinationInput(dest) {
  if (dest == null) return "";
  if (Array.isArray(dest)) return dest.map((x) => String(x).trim()).filter(Boolean).join(", ");
  return String(dest).trim();
}

function sameDate(a, b) {
  if (a == null && b == null) return true;
  const sa = a != null ? String(a).slice(0, 10) : "";
  const sb = b != null ? String(b).slice(0, 10) : "";
  return sa === sb;
}

/** Non-operator tried to change a field that only admin may change on confirmed policies */
function operatorTriedForbiddenChange(traveller, caseData, existing) {
  const tKeys = [
    "date_of_birth",
    "country_of_residence",
    "gender",
    "nationality",
    "passport_or_id",
    "phone",
    "email",
    "address"
  ];
  for (const k of tKeys) {
    if (traveller[k] === undefined) continue;
    const nv = String(traveller[k] ?? "").trim();
    const ov = String(existing[k] ?? "").trim();
    if (nv !== ov) return true;
  }
  if (
    caseData.selected_plan_id !== undefined &&
    Number(caseData.selected_plan_id) !== Number(existing.selected_plan_id)
  ) {
    return true;
  }
  if (caseData.status !== undefined && String(caseData.status) !== String(existing.status ?? "")) {
    return true;
  }
  return false;
}

function buildOperatorMergedPayload(existing, traveller, caseData) {
  return {
    traveller: {
      first_name: traveller.first_name !== undefined ? String(traveller.first_name).trim() : existing.first_name,
      last_name: traveller.last_name !== undefined ? String(traveller.last_name).trim() : existing.last_name,
      date_of_birth: existing.date_of_birth,
      country_of_residence: existing.country_of_residence,
      gender: existing.gender,
      nationality: existing.nationality,
      passport_or_id: existing.passport_or_id,
      phone: existing.phone,
      email: existing.email,
      address: existing.address
    },
    caseData: {
      destination:
        caseData.destination !== undefined ? normalizeDestinationInput(caseData.destination) : existing.destination,
      start_date: caseData.start_date !== undefined ? caseData.start_date : existing.start_date,
      end_date: caseData.end_date !== undefined ? caseData.end_date : existing.end_date,
      selected_plan_id: existing.selected_plan_id,
      status: existing.status || "Confirmed"
    }
  };
}

function allowedLimitedFieldsChanged(existing, merged) {
  const tChanged =
    String(merged.traveller.first_name ?? "").trim() !== String(existing.first_name ?? "").trim() ||
    String(merged.traveller.last_name ?? "").trim() !== String(existing.last_name ?? "").trim();
  const cChanged =
    normalizeDestinationInput(merged.caseData.destination) !== normalizeDestinationInput(existing.destination) ||
    !sameDate(merged.caseData.start_date, existing.start_date) ||
    !sameDate(merged.caseData.end_date, existing.end_date);
  return tChanged || cChanged;
}

function handleCaseWriteError(err, res) {
  if (err?.code === INVALID_DATE_OF_BIRTH_CODE) {
    return res.status(400).json({ message: err.message });
  }
  console.error(err);
  return res.status(500).json({ message: "Server error" });
}

/** Multiple travellers sharing the same trip/plan (Excel group subscription) */
export const createGroupCasesWithTravellers = async (req, res) => {
  try {
    const { travellers, caseData } = req.body;
    const created_by = req.user.id;

    if (!Array.isArray(travellers) || travellers.length === 0) {
      return res.status(400).json({ message: "At least one traveller is required" });
    }
    if (travellers.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ message: `Maximum ${MAX_GROUP_MEMBERS} travellers per group` });
    }
    if (!caseData?.selected_plan_id || !caseData?.start_date || !caseData?.end_date) {
      return res.status(400).json({ message: "Missing case details (plan, dates)" });
    }

    const group_id = uuidv4();
    const caseIds = [];

    for (const traveller of travellers) {
      const dobPresent = String(traveller?.date_of_birth ?? "").trim();
      if (!traveller?.first_name?.trim() || !traveller?.last_name?.trim() || !dobPresent) {
        return res.status(400).json({ message: "Each traveller must have surname, given names, and date of birth" });
      }
      const travellerId = await createTraveller(traveller);
      const cid = await createCase({
        ...caseData,
        traveller_id: travellerId,
        created_by,
        group_id
      });
      caseIds.push(cid);
    }

    try {
      await logActivity(created_by, `Created group subscription — ${caseIds.length} cases — group ${group_id}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    res.status(201).json({
      message: "Group cases created successfully",
      groupId: group_id,
      caseIds
    });
  } catch (err) {
    return handleCaseWriteError(err, res);
  }
};

// Create Traveller + Case
export const createCaseWithTraveller = async (req, res) => {
  try {
    const { traveller, caseData } = req.body;
    const created_by = req.user.id; 

    // 1. Create traveller
    const travellerId = await createTraveller(traveller);

    // 2. Create case
    const caseId = await createCase({ ...caseData, traveller_id: travellerId, created_by });

    // 3. Log activity (safe, won't break flow)
    try {
      await logActivity(created_by, `Created Case - ID:${caseId}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    // 4. Send response
    res.status(201).json({ message: "Case created successfully", caseId });
  } catch (err) {
    return handleCaseWriteError(err, res);
  }
};


// Get all cases for logged-in Agent (includes sub-agent cases for main agents)
export const getMyCases = async (req, res) => {
  try {
    const agentIds = await getAgentVisibilityIds(req.user.id);
    const cases = await getCasesByAgentIds(agentIds);
    res.json(cases);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get cases without sales (pending sales) - agent + sub-agents
export const getPendingSales = async (req, res) => {
  try {
    const agentIds = await getAgentVisibilityIds(req.user.id);
    const cases = await getCasesWithoutSalesByAgentIds(agentIds);
    res.json(cases);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Update case status
export const changeCaseStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await updateCaseStatus(id, status);
    res.json({ message: "Case status updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get all cases with pagination (admin only)
export const getAllCases = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    
    const result = await getAllCasesWithPagination(page, limit);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get cases for agent with pagination (agent + sub-agents)
export const getMyCasesWithPagination = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const agentIds = await getAgentVisibilityIds(req.user.id);
    const result = await getCasesByAgentIdsWithPagination(agentIds, page, limit);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Confirm sale for a case (admin only)
export const confirmSale = async (req, res) => {
  try {
    const { caseId } = req.params;
    const { premium_amount, tax = 0, total } = req.body;
    
    if (!premium_amount || !total) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Generate policy and certificate numbers
    const policyNumber = `POL-${Date.now()}`;
    const certificateNumber = `CERT-${Date.now()}`;

    // Create sale
    const saleId = await createSale({
      case_id: caseId,
      policy_number: policyNumber,
      certificate_number: certificateNumber,
      premium_amount: Number(premium_amount),
      tax: Number(tax),
      total: Number(total)
    });

    // Log activity
    try {
      await logActivity(req.user.id, `Confirmed Sale for Case ${caseId} - Sale ID: ${saleId}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    res.json({ 
      message: "Sale confirmed successfully", 
      saleId,
      policyNumber,
      certificateNumber
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Cancel case (admin only)
export const cancelCase = async (req, res) => {
  try {
    const { caseId } = req.params;
    
    // Update case status to cancelled
    await updateCaseStatus(caseId, 'Cancelled');

    // Log activity
    try {
      await logActivity(req.user.id, `Cancelled Case ${caseId}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    res.json({ message: "Case cancelled successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

/** Who may edit what on a confirmed sale — used by the SPA */
export const getPolicyEditMeta = async (req, res) => {
  try {
    const { caseId } = req.params;
    const access = await assertUserCanAccessCase(req, caseId);
    if (access.error) return res.status(access.error).json({ message: access.message });

    const ex = access.caseRow;
    const sale = await getSaleByCaseId(caseId);
    const role = req.user.role;
    const isAdmin = role === "admin";
    const count = sale ? Number(sale.policy_edit_count) || 0 : 0;
    const start = ex.start_date;
    const opWindow = operatorLimitedEditOpen(start);
    const inLast24 = inLast24HoursBeforeDeparture(start);
    const departed = hasDeparted(start);

    const agentMayEditLimitedFields =
      !isAdmin && !!sale && opWindow && count < MAX_OPERATOR_POLICY_EDITS;
    const adminMayEditAllFields = isAdmin && !!sale;
    const agentBlockedFromEditing = !isAdmin && !!sale && !agentMayEditLimitedFields;

    res.json({
      success: true,
      data: {
        hasSale: !!sale,
        saleId: sale?.id ?? null,
        policyEditCount: count,
        policyEditsRemaining: sale ? Math.max(0, MAX_OPERATOR_POLICY_EDITS - count) : 0,
        departureDate: start,
        operatorLimitedEditOpen: opWindow,
        inLast24HoursBeforeDeparture: inLast24,
        hasDeparted: departed,
        agentMayEditLimitedFields,
        adminMayEditAllFields,
        agentBlockedFromEditing
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Update case and traveller
export const updateCase = async (req, res) => {
  try {
    const { caseId } = req.params;
    let { traveller, caseData } = req.body;

    if (!traveller || !caseData) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const access = await assertUserCanAccessCase(req, caseId);
    if (access.error) return res.status(access.error).json({ message: access.message });

    const existing = access.caseRow;
    const sale = await getSaleByCaseId(caseId);
    const role = req.user.role;
    const isAdmin = role === "admin";

    let shouldIncrementOperatorEdit = false;

    if (sale) {
      if (isAdmin) {
        // Admin may edit all fields any time while case exists (including within 24h of departure)
        // Pass body through unchanged
      } else {
        // Agent / operator
        if (operatorTriedForbiddenChange(traveller, caseData, existing)) {
          return res.status(403).json({
            message:
              "You may only change first name, last name, destination, and travel dates on a confirmed policy, and only more than 24 hours before departure."
          });
        }
        if (!operatorLimitedEditOpen(existing.start_date)) {
          return res.status(403).json({
            message:
              "Confirmed policies can no longer be edited by operators within 24 hours of departure. Contact an administrator."
          });
        }
        const count = Number(sale.policy_edit_count) || 0;
        if (count >= MAX_OPERATOR_POLICY_EDITS) {
          return res.status(403).json({
            message: `Maximum of ${MAX_OPERATOR_POLICY_EDITS} post-confirmation corrections reached. Contact an administrator.`
          });
        }
        const merged = buildOperatorMergedPayload(existing, traveller, caseData);
        if (!allowedLimitedFieldsChanged(existing, merged)) {
          return res.status(400).json({ message: "No permitted changes detected" });
        }
        traveller = merged.traveller;
        caseData = merged.caseData;
        shouldIncrementOperatorEdit = true;
      }
    }

    if (caseData.start_date && caseData.end_date) {
      const s = new Date(caseData.start_date);
      const e = new Date(caseData.end_date);
      if (e < s) {
        return res.status(400).json({ message: "End date cannot be before start date" });
      }
    }

    await updateCaseAndTraveller(caseId, traveller, caseData);

    if (shouldIncrementOperatorEdit && sale?.id) {
      try {
        await incrementPolicyEditCount(sale.id);
      } catch (incErr) {
        console.error("policy_edit_count increment failed:", incErr.message);
      }
    }

    try {
      await logActivity(req.user.id, `Updated Case ${caseId}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    const saleAfter = await getSaleByCaseId(caseId);
    const newCount = saleAfter ? Number(saleAfter.policy_edit_count) || 0 : 0;

    res.json({
      message: "Case updated successfully",
      policyEditCount: saleAfter ? newCount : undefined,
      policyEditsRemaining: saleAfter ? Math.max(0, MAX_OPERATOR_POLICY_EDITS - newCount) : undefined
    });
  } catch (err) {
    return handleCaseWriteError(err, res);
  }
};
