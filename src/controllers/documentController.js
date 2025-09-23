import path from "path";
import { fileURLToPath } from "url";
import { getInvoiceBySaleId } from "../models/invoiceModel.js";
import { getCertificateBySaleId } from "../models/certificateModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const downloadInvoice = async (req, res) => {
  try {
    const saleId = req.params.id;
    const invoice = await getInvoiceBySaleId(saleId);
    if (!invoice || !invoice.pdf_path) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const filePath = path.join(__dirname, "..", invoice.pdf_path);
    const fileUrl = `${process.env.BASE_URL}/${invoice.pdf_path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

    // If you want direct download in browser
    return res.json({ url: fileUrl });

    // OR if you want to stream file directly
    // return res.download(filePath, "invoice.pdf");
  } catch (err) {
    console.error("Error downloading invoice:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const downloadCertificate = async (req, res) => {
  try {
    const saleId = req.params.id;
    const cert = await getCertificateBySaleId(saleId);
    if (!cert || !cert.pdf_path) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    const filePath = path.join(__dirname, "..", cert.pdf_path);
    const fileUrl = `${process.env.BASE_URL}/${cert.pdf_path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

    return res.json({ url: fileUrl });
  } catch (err) {
    console.error("Error downloading certificate:", err);
    res.status(500).json({ message: "Server error" });
  }
};
