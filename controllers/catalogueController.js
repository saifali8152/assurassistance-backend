import getPool from "../utils/db.js"; // your mysql connection

// Create catalogue plan
export const createCatalogue = async (req, res) => {
    try {
        const pool = getPool();
        const { product_type, name, coverage, pricing_rules, flat_price, country_of_residence, route_type, currency } = req.body;
        
        // Handle country_of_residence: convert empty string to null, otherwise use the value
        const countryValue = (country_of_residence && typeof country_of_residence === 'string' && country_of_residence.trim() !== '') 
            ? country_of_residence.trim() 
            : null;
        
        // Handle route_type: convert empty string to null, otherwise use the value
        const routeValue = (route_type && typeof route_type === 'string' && route_type.trim() !== '') 
            ? route_type.trim() 
            : null;
        
        const coverageValue = (coverage != null && String(coverage).trim() !== '') ? String(coverage).trim() : null;
        
        await pool.query(
            `INSERT INTO catalogue (product_type, name, coverage, pricing_rules, flat_price, country_of_residence, route_type, currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [product_type, name, coverageValue, JSON.stringify(pricing_rules), flat_price, countryValue, routeValue, currency || 'XOF']
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
        const pool = getPool();
        let query = 'SELECT * FROM catalogue';
        // Agents should only see active plans
        if (req.user.role === 'agent') {
            query += ' WHERE active = true';
        }
        const [rows] = await pool.query(query);
        // Parse pricing_rules JSON if it exists
        const parsedRows = rows.map(row => {
            if (row.pricing_rules && typeof row.pricing_rules === 'string') {
                try {
                    row.pricing_rules = JSON.parse(row.pricing_rules);
                } catch (e) {
                    console.error('Error parsing pricing_rules:', e);
                    row.pricing_rules = null;
                }
            }
            return row;
        });
        res.json({ success: true, data: parsedRows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error fetching catalogues' });
    }
};

// Update catalogue
export const updateCatalogue = async (req, res) => {
    try {
        const pool = getPool();
        const { id } = req.params;
        const { product_type, name, coverage, pricing_rules, flat_price, active, country_of_residence, route_type, currency } = req.body;
        
        // Handle country_of_residence: convert empty string to null, otherwise use the value
        const countryValue = (country_of_residence && typeof country_of_residence === 'string' && country_of_residence.trim() !== '') 
            ? country_of_residence.trim() 
            : null;
        
        // Handle route_type: convert empty string to null, otherwise use the value
        const routeValue = (route_type && typeof route_type === 'string' && route_type.trim() !== '') 
            ? route_type.trim() 
            : null;
        
        const coverageValue = (coverage != null && String(coverage).trim() !== '') ? String(coverage).trim() : null;
        
        await pool.query(
            `UPDATE catalogue SET product_type=?, name=?, coverage=?, pricing_rules=?, flat_price=?, active=?, country_of_residence=?, route_type=?, currency=? WHERE id=?`,
            [product_type, name, coverageValue, JSON.stringify(pricing_rules), flat_price, active, countryValue, routeValue, currency || 'XOF', id]
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
        const pool = getPool();
        const { id } = req.params;
        await pool.query('DELETE FROM catalogue WHERE id = ?', [id]);
        res.json({ success: true, message: 'Catalogue deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error deleting catalogue' });
    }
};
