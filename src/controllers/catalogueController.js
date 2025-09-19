import pool from "../db.js"; // your mysql connection

// Create catalogue plan
export const createCatalogue = async (req, res) => {
    try {
        const { product_type, name, coverage, eligible_destinations, durations, pricing_rules, flat_price, terms, active } = req.body;
        await pool.query(
            `INSERT INTO catalogue (product_type, name, coverage, eligible_destinations, durations, pricing_rules, flat_price, terms, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [product_type, name, coverage, eligible_destinations, durations, JSON.stringify(pricing_rules), flat_price, terms, active]
        );
        res.status(201).json({ success: true, message: 'Catalogue plan created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error creating catalogue' });
    }
};

// Get all catalogues
export const getCatalogues = async (req, res) => {
    try {
        let query = 'SELECT * FROM catalogue';
        // Agents should only see active plans
        if (req.user.role === 'agent') {
            query += ' WHERE active = true';
        }
        const [rows] = await pool.query(query);
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error fetching catalogues' });
    }
};

// Update catalogue
export const updateCatalogue = async (req, res) => {
    try {
        const { id } = req.params;
        const { product_type, name, coverage, eligible_destinations, durations, pricing_rules, flat_price, terms, active } = req.body;
        await pool.query(
            `UPDATE catalogue SET product_type=?, name=?, coverage=?, eligible_destinations=?, durations=?, pricing_rules=?, flat_price=?, terms=?, active=? WHERE id=?`,
            [product_type, name, coverage, eligible_destinations, durations, JSON.stringify(pricing_rules), flat_price, terms, active, id]
        );
        res.json({ success: true, message: 'Catalogue updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error updating catalogue' });
    }
};

// Delete catalogue
export const deleteCatalogue = async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM catalogue WHERE id = ?', [id]);
        res.json({ success: true, message: 'Catalogue deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error deleting catalogue' });
    }
};
