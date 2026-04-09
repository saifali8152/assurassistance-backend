import getPool from "../utils/db.js";
import path from "path";
import fs from "fs";
import multer from "multer";

const planLogoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), "uploads", "plan-logos");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowed = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"];
    const safeExt = allowed.includes(ext) ? ext : ".png";
    cb(null, `plan-${req.params.id}-${Date.now()}${safeExt}`);
  }
});

/** Single image for catalogue partner insurer logo (certificate header). Field name: partner_logo */
export const uploadPartnerLogoMiddleware = multer({
  storage: planLogoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const ok = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext);
    if (ok) cb(null, true);
    else cb(new Error("Only PNG, JPG, JPEG, GIF, SVG, or WEBP images are allowed"));
  }
}).single("partner_logo");

function publicAssetUrl(req, relativePath) {
  if (!relativePath) return null;
  const p = String(relativePath).trim();
  if (/^https?:\/\//i.test(p)) return p;
  const envBase = (process.env.BASE_URL || "").replace(/\/$/, "");
  if (envBase) return `${envBase}${p.startsWith("/") ? "" : "/"}${p}`;
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  if (!host) return p.startsWith("/") ? p : `/${p}`;
  return `${proto}://${host}${p.startsWith("/") ? "" : "/"}${p}`;
}

// Create catalogue plan
export const createCatalogue = async (req, res) => {
  try {
    const pool = getPool();
    const {
      product_type,
      name,
      coverage,
      pricing_rules,
      flat_price,
      country_of_residence,
      route_type,
      currency
    } = req.body;

    const countryValue =
      country_of_residence && typeof country_of_residence === "string" && country_of_residence.trim() !== ""
        ? country_of_residence.trim()
        : null;

    const routeValue =
      route_type && typeof route_type === "string" && route_type.trim() !== "" ? route_type.trim() : null;

    const coverageValue = coverage != null && String(coverage).trim() !== "" ? String(coverage).trim() : null;

    const [result] = await pool.query(
      `INSERT INTO catalogue (product_type, name, coverage, pricing_rules, flat_price, country_of_residence, route_type, currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [product_type, name, coverageValue, JSON.stringify(pricing_rules), flat_price, countryValue, routeValue, currency || "XOF"]
    );
    res.status(201).json({
      success: true,
      message: "Catalogue plan created successfully",
      id: result.insertId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating catalogue" });
  }
};

// Get all catalogues (Admin: all plans; Agent/Sub-agent: only assigned plans)
export const getCatalogues = async (req, res) => {
  try {
    const pool = getPool();
    let query;
    const params = [];
    if (req.user.role === "admin") {
      query = "SELECT * FROM catalogue";
    } else {
      query = `SELECT c.* FROM catalogue c
                INNER JOIN user_assigned_plans uap ON uap.catalogue_id = c.id AND uap.user_id = ?
                WHERE c.active = true`;
      params.push(req.user.id);
    }
    const [rows] = await pool.query(query, params);
    const parsedRows = rows.map((row) => {
      if (row.pricing_rules && typeof row.pricing_rules === "string") {
        try {
          row.pricing_rules = JSON.parse(row.pricing_rules);
        } catch (e) {
          console.error("Error parsing pricing_rules:", e);
          row.pricing_rules = null;
        }
      }
      return row;
    });
    res.json({ success: true, data: parsedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error fetching catalogues" });
  }
};

// Update catalogue
export const updateCatalogue = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const {
      product_type,
      name,
      coverage,
      pricing_rules,
      flat_price,
      active,
      country_of_residence,
      route_type,
      currency
    } = req.body;

    const countryValue =
      country_of_residence && typeof country_of_residence === "string" && country_of_residence.trim() !== ""
        ? country_of_residence.trim()
        : null;

    const routeValue =
      route_type && typeof route_type === "string" && route_type.trim() !== "" ? route_type.trim() : null;

    const coverageValue = coverage != null && String(coverage).trim() !== "" ? String(coverage).trim() : null;

    await pool.query(
      `UPDATE catalogue SET product_type=?, name=?, coverage=?, pricing_rules=?, flat_price=?, active=?, country_of_residence=?, route_type=?, currency=? WHERE id=?`,
      [
        product_type,
        name,
        coverageValue,
        JSON.stringify(pricing_rules),
        flat_price,
        active,
        countryValue,
        routeValue,
        currency || "XOF",
        id
      ]
    );
    res.json({ success: true, message: "Catalogue updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error updating catalogue" });
  }
};

// Delete catalogue
export const deleteCatalogue = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    await pool.query("DELETE FROM catalogue WHERE id = ?", [id]);
    res.json({ success: true, message: "Catalogue deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error deleting catalogue" });
  }
};

/** POST multipart partner_logo — saves under /uploads/plan-logos/ and updates catalogue.partner_insurer_logo */
export const uploadPartnerInsurerLogo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file (field name: partner_logo)" });
    }
    const { id } = req.params;
    const pool = getPool();
    const [rows] = await pool.query("SELECT partner_insurer_logo FROM catalogue WHERE id = ?", [id]);
    if (!rows.length) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
      return res.status(404).json({ success: false, message: "Plan not found" });
    }
    const prev = rows[0].partner_insurer_logo;
    if (prev && typeof prev === "string" && prev.includes("plan-logos")) {
      const oldPath = path.join(process.cwd(), prev.replace(/^\//, ""));
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (_) {}
    }
    const relative = `/uploads/plan-logos/${path.basename(req.file.path)}`;
    await pool.query("UPDATE catalogue SET partner_insurer_logo = ? WHERE id = ?", [relative, id]);
    res.json({
      success: true,
      partner_insurer_logo: relative,
      partnerLogoUrl: publicAssetUrl(req, relative)
    });
  } catch (err) {
    console.error(err);
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    res.status(500).json({ success: false, message: "Error uploading partner logo" });
  }
};

/** Remove partner logo file and clear DB field */
export const deletePartnerInsurerLogo = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();
    const [rows] = await pool.query("SELECT partner_insurer_logo FROM catalogue WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }
    const prev = rows[0].partner_insurer_logo;
    if (prev && typeof prev === "string" && prev.includes("plan-logos")) {
      const oldPath = path.join(process.cwd(), prev.replace(/^\//, ""));
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (_) {}
    }
    await pool.query("UPDATE catalogue SET partner_insurer_logo = NULL WHERE id = ?", [id]);
    res.json({ success: true, message: "Partner logo removed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error removing partner logo" });
  }
};
