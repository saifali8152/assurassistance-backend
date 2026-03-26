// src/controllers/caseController.js
import { v4 as uuidv4 } from "uuid";
import { createTraveller, createCase, getCasesByAgentIds, getCasesWithoutSalesByAgentIds, updateCaseStatus, getAllCasesWithPagination, getCasesByAgentIdsWithPagination, updateCaseAndTraveller } from "../models/caseModel.js";
import { getAgentVisibilityIds } from "../models/userModel.js";
import { createSale } from "../models/salesModel.js";
import { logActivity } from "../models/activityModel.js";  // <-- make sure this exists
import { INVALID_DATE_OF_BIRTH_CODE } from "../utils/parseFlexibleDate.js";

const MAX_GROUP_MEMBERS = 500;

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

// Update case and traveller
export const updateCase = async (req, res) => {
  try {
    const { caseId } = req.params;
    const { traveller, caseData } = req.body;
    
    if (!traveller || !caseData) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Update case and traveller
    await updateCaseAndTraveller(caseId, traveller, caseData);

    // Log activity
    try {
      await logActivity(req.user.id, `Updated Case ${caseId}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    res.json({ message: "Case updated successfully" });
  } catch (err) {
    return handleCaseWriteError(err, res);
  }
};
