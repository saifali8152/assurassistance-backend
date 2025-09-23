import path from "path";
import { getInvoiceBySaleId } from "../models/invoiceModel.js";
import { getCertificateBySaleId } from "../models/certificateModel.js";

export const downloadInvoice = async (req, res) => {
  try {
    const saleId = req.params.id;
    const invoice = await getInvoiceBySaleId(saleId);
    if (!invoice || !invoice.pdf_path) return res.status(404).json({ message: "Invoice not found" });

    const filePath = path.join(process.cwd(), invoice.pdf_path);
    return res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const downloadCertificate = async (req, res) => {
  try {
    const saleId = req.params.id;
    const cert = await getCertificateBySaleId(saleId);
    if (!cert || !cert.pdf_path) return res.status(404).json({ message: "Certificate not found" });

    const filePath = path.join(process.cwd(), cert.pdf_path);
    return res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
