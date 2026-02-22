// src/controllers/caseController.js
import { createTraveller, createCase, getCasesByAgent, getCasesWithoutSales, updateCaseStatus, getAllCasesWithPagination, getCasesByAgentWithPagination, updateCaseAndTraveller } from "../models/caseModel.js";
import { createSale } from "../models/salesModel.js";
import { logActivity } from "../models/activityModel.js";  // <-- make sure this exists

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
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};


// Get all cases for logged-in Agent
export const getMyCases = async (req, res) => {
  try {
    const cases = await getCasesByAgent(req.user.id);
    res.json(cases);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get cases without sales (pending sales)
export const getPendingSales = async (req, res) => {
  try {
    const cases = await getCasesWithoutSales(req.user.id);
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

// Get cases for agent with pagination
export const getMyCasesWithPagination = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    
    const result = await getCasesByAgentWithPagination(req.user.id, page, limit);
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
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
