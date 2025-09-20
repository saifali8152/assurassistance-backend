import { v4 as uuidv4 } from "uuid";
import { createSale, getAllSales, getSaleById } from "../models/salesModel.js";

// Create Sale
export const createSaleController = async (req, res) => {
  try {
    const { case_id, premium_amount, tax, total } = req.body;

    if (!case_id || !premium_amount || !total) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Generate unique numbers
    const policyNumber = `POL-${Date.now()}`;
    const certificateNumber = `CERT-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Save Sale in DB
    const saleId = await createSale({
      case_id,
      policy_number: policyNumber,
      certificate_number: certificateNumber,
      premium_amount,
      tax: tax || 0,
      total
    });

    res.status(201).json({
      message: "Sale created successfully",
      saleId,
      policyNumber,
      certificateNumber
    });
  } catch (err) {
    console.error("Error creating sale:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get all Sales
export const getAllSalesController = async (req, res) => {
  try {
    const sales = await getAllSales();
    res.json(sales);
  } catch (err) {
    console.error("Error fetching sales:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get Sale by ID
export const getSaleByIdController = async (req, res) => {
  try {
    const saleId = req.params.id;
    const sale = await getSaleById(saleId);

    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    res.json(sale);
  } catch (err) {
    console.error("Error fetching sale:", err);
    res.status(500).json({ message: "Server error" });
  }
};
