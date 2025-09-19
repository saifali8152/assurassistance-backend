import { createTraveller, createCase, getCasesByAgent, updateCaseStatus } from "../models/caseModel.js";

// Create Traveller + Case
export const createCaseWithTraveller = async (req, res) => {
  try {
    const { traveller, caseData } = req.body;
    const created_by = req.user.id; // From auth middleware

    // 1. Create traveller
    const travellerId = await createTraveller(traveller);

    // 2. Create case
    const caseId = await createCase({ ...caseData, traveller_id: travellerId, created_by });

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
