-- Seed / refresh Agico Burundi duration premiums for the two plans.
-- Run after add_fixed_duration_premiums_to_catalogue.sql
--
-- Agico Retail Burundi (Travel) / Agico Road Travel Burundi (Road travel):
--   10 Days  (0–10)    → 20 / 8
--   32 Days  (11–32)   → 39 / 11
--   45 Days  (33–45)   → 57 / 15
--   63 Days  (46–63)   → 67 / 18
--   93 Days  (64–93)   → 75 / 21
--   180 Days (94–180)  → 101 / 38
--   365 Days (181–365) → 131 / 71
--
-- Currency: USD (admin can change later). Flag: fixed_duration_premiums = 1.

SET @retail_pricing := CAST('{
  "pricingColumns": ["Worldwide"],
  "pricing": [
    {"id": "agico-retail-10",  "label": "10 Days",  "columns": {"Worldwide": 20}},
    {"id": "agico-retail-32",  "label": "32 Days",  "columns": {"Worldwide": 39}},
    {"id": "agico-retail-45",  "label": "45 Days",  "columns": {"Worldwide": 57}},
    {"id": "agico-retail-63",  "label": "63 Days",  "columns": {"Worldwide": 67}},
    {"id": "agico-retail-93",  "label": "93 Days",  "columns": {"Worldwide": 75}},
    {"id": "agico-retail-180", "label": "180 Days", "columns": {"Worldwide": 101}},
    {"id": "agico-retail-365", "label": "365 Days", "columns": {"Worldwide": 131}}
  ],
  "guarantees": [
    {"id": "agico-retail-g1",  "category": "MEDICAL",   "coverageType": "medicalEmergencies",     "amount": null},
    {"id": "agico-retail-g2",  "category": "MEDICAL",   "coverageType": "medicalTransport",       "amount": null},
    {"id": "agico-retail-g3",  "category": "MEDICAL",   "coverageType": "hospitalization",        "amount": 40000000},
    {"id": "agico-retail-g4",  "category": "MEDICAL",   "coverageType": "evacuationRepatriation", "amount": 80000000},
    {"id": "agico-retail-g5",  "category": "MEDICAL",   "coverageType": "bodyRepatriation",       "amount": 5000000},
    {"id": "agico-retail-g6",  "category": "TRAVEL",    "coverageType": "tripCancellation",       "amount": 600000},
    {"id": "agico-retail-g7",  "category": "TRAVEL",    "coverageType": "baggageDeliveryDelay",   "amount": 50000},
    {"id": "agico-retail-g8",  "category": "TRAVEL",    "coverageType": "passportLoss",           "amount": 80000},
    {"id": "agico-retail-g9",  "category": "JURIDICAL", "coverageType": "civilLiability",         "amount": 2000000},
    {"id": "agico-retail-g10", "category": "JURIDICAL", "coverageType": "legalAssistance",        "amount": null},
    {"id": "agico-retail-g11", "category": "JURIDICAL", "coverageType": "bail",                   "amount": 200000}
  ]
}' AS JSON);

SET @road_pricing := CAST('{
  "pricingColumns": ["By Road"],
  "pricing": [
    {"id": "agico-road-10",  "label": "10 Days",  "columns": {"By Road": 8}},
    {"id": "agico-road-32",  "label": "32 Days",  "columns": {"By Road": 11}},
    {"id": "agico-road-45",  "label": "45 Days",  "columns": {"By Road": 15}},
    {"id": "agico-road-63",  "label": "63 Days",  "columns": {"By Road": 18}},
    {"id": "agico-road-93",  "label": "93 Days",  "columns": {"By Road": 21}},
    {"id": "agico-road-180", "label": "180 Days", "columns": {"By Road": 38}},
    {"id": "agico-road-365", "label": "365 Days", "columns": {"By Road": 71}}
  ],
  "guarantees": [
    {"id": "agico-road-g1",  "category": "MEDICAL",   "coverageType": "medicalEmergencies",     "amount": null},
    {"id": "agico-road-g2",  "category": "MEDICAL",   "coverageType": "medicalTransport",       "amount": null},
    {"id": "agico-road-g3",  "category": "MEDICAL",   "coverageType": "hospitalization",        "amount": 9000000},
    {"id": "agico-road-g4",  "category": "MEDICAL",   "coverageType": "evacuationRepatriation", "amount": 10000000},
    {"id": "agico-road-g5",  "category": "MEDICAL",   "coverageType": "bodyRepatriation",       "amount": 1000000},
    {"id": "agico-road-g6",  "category": "TRAVEL",    "coverageType": "tripCancellation",       "amount": 100000},
    {"id": "agico-road-g7",  "category": "TRAVEL",    "coverageType": "baggageDeliveryDelay",   "amount": null},
    {"id": "agico-road-g8",  "category": "TRAVEL",    "coverageType": "passportLoss",           "amount": null},
    {"id": "agico-road-g9",  "category": "JURIDICAL", "coverageType": "civilLiability",         "amount": null},
    {"id": "agico-road-g10", "category": "JURIDICAL", "coverageType": "legalAssistance",        "amount": null},
    {"id": "agico-road-g11", "category": "JURIDICAL", "coverageType": "bail",                   "amount": null}
  ]
}' AS JSON);

-- ---- Agico Retail Burundi (Travel) ----
UPDATE `catalogue`
SET
  `product_type` = 'Travel',
  `coverage` = 'Agico Retail Burundi — duration-based travel premiums (fixed table).',
  `durations` = '10,32,45,63,93,180,365',
  `pricing_rules` = @retail_pricing,
  `flat_price` = NULL,
  `country_of_residence` = 'Burundi',
  `route_type` = 'By Air',
  `currency` = 'USD',
  `theme_color` = '#E4590F',
  `extra_id_fields` = 0,
  `fixed_duration_premiums` = 1,
  `active` = 1
WHERE `name` IN ('Agico Retail Burundi', 'AGICO Retail Burundi');

INSERT INTO `catalogue` (
  `product_type`, `name`, `coverage`, `durations`, `pricing_rules`, `flat_price`,
  `country_of_residence`, `route_type`, `currency`, `theme_color`,
  `extra_id_fields`, `fixed_duration_premiums`, `active`
)
SELECT
  'Travel',
  'Agico Retail Burundi',
  'Agico Retail Burundi — duration-based travel premiums (fixed table).',
  '10,32,45,63,93,180,365',
  @retail_pricing,
  NULL,
  'Burundi',
  'By Air',
  'USD',
  '#E4590F',
  0,
  1,
  1
WHERE NOT EXISTS (
  SELECT 1 FROM `catalogue`
  WHERE `name` IN ('Agico Retail Burundi', 'AGICO Retail Burundi')
);

-- ---- Agico Road Travel Burundi (Road travel) ----
UPDATE `catalogue`
SET
  `product_type` = 'Road travel',
  `coverage` = 'Agico Road Travel Burundi — duration-based road travel premiums (fixed table).',
  `durations` = '10,32,45,63,93,180,365',
  `pricing_rules` = @road_pricing,
  `flat_price` = NULL,
  `country_of_residence` = 'Burundi',
  `route_type` = 'By Road',
  `currency` = 'USD',
  `theme_color` = '#E4590F',
  `extra_id_fields` = 1,
  `fixed_duration_premiums` = 1,
  `active` = 1
WHERE `name` IN ('Agico Road Travel Burundi', 'AGICO Road Travel Burundi');

INSERT INTO `catalogue` (
  `product_type`, `name`, `coverage`, `durations`, `pricing_rules`, `flat_price`,
  `country_of_residence`, `route_type`, `currency`, `theme_color`,
  `extra_id_fields`, `fixed_duration_premiums`, `active`
)
SELECT
  'Road travel',
  'Agico Road Travel Burundi',
  'Agico Road Travel Burundi — duration-based road travel premiums (fixed table).',
  '10,32,45,63,93,180,365',
  @road_pricing,
  NULL,
  'Burundi',
  'By Road',
  'USD',
  '#E4590F',
  1,
  1,
  1
WHERE NOT EXISTS (
  SELECT 1 FROM `catalogue`
  WHERE `name` IN ('Agico Road Travel Burundi', 'AGICO Road Travel Burundi')
);
