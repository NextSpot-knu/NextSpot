const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL || 'https://xdwnwrthrgflbzpvkouq.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Please run: node --env-file=.env.local scripts/seed_parking.js");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Simple CSV parser for quoted fields
function parseCSV(text) {
  let p = '', row = [''], ret = [row], i = 0, r = 0, s = !0, l;
  for (l of text) {
    if ('"' === l) {
      if (s && l === p) row[i] += l;
      s = !s;
    } else if (',' === l && s) l = row[++i] = '';
    else if ('\n' === l && s) {
      if ('\r' === p) row[i] = row[i].slice(0, -1);
      row = ret[++r] = [l = '']; i = 0;
    } else row[i] += l;
    p = l;
  }
  return ret.filter(r => r.length > 1 || r[0] !== '');
}

async function seedParking() {
  const privateCsvPath = path.join(__dirname, '..', 'samples', 'gumi_parking_private.csv');
  const publicCsvPath = path.join(__dirname, '..', 'samples', 'gumi_parking.csv');
  
  const facilitiesToInsert = [];

  // Helper to parse a single CSV file and add to list
  function processCsvFile(filePath) {
    if (!fs.existsSync(filePath)) {
      console.warn(`CSV file not found at ${filePath}`);
      return;
    }
    const csvContent = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCSV(csvContent);
    const headers = rows[0];
    const dataRows = rows.slice(1);

    for (const row of dataRows) {
      if (row.length < headers.length) continue;

      const name = row[1];
      const type = row[2];
      const latitude = parseFloat(row[3]);
      const longitude = parseFloat(row[4]);
      const capacity = parseInt(row[5], 10);
      
      let operating_hours = {};
      try {
        operating_hours = JSON.parse(row[6] || '{}');
      } catch (e) {
        console.warn(`Failed to parse operating_hours for ${name}`);
      }

      let features = {};
      try {
        features = JSON.parse(row[7] || '{}');
      } catch (e) {
        console.warn(`Failed to parse features for ${name}`);
      }

      const max_capacity_vehicles = parseInt(row[8], 10);
      if (!isNaN(max_capacity_vehicles)) {
        features.max_capacity_vehicles = max_capacity_vehicles;
      }

      facilitiesToInsert.push({
        name,
        type,
        latitude,
        longitude,
        capacity,
        operating_hours,
        features
      });
    }
  }

  console.log('Parsing CSV files...');
  processCsvFile(publicCsvPath);
  console.log(`Loaded public parking lots. Total facilities count: ${facilitiesToInsert.length}`);
  processCsvFile(privateCsvPath);
  console.log(`Loaded private parking lots. Total facilities count: ${facilitiesToInsert.length}`);

  console.log('Deleting existing parking facilities to avoid duplicates...');
  const { error: deleteError } = await supabase
    .from('facilities')
    .delete()
    .eq('type', 'parking');

  if (deleteError) {
    console.error('Error deleting existing parking facilities:', deleteError);
    return;
  }

  console.log(`Inserting ${facilitiesToInsert.length} parking facilities into Supabase...`);
  const { data: insertedFacilities, error: insertError } = await supabase
    .from('facilities')
    .insert(facilitiesToInsert)
    .select();

  if (insertError) {
    console.error('Error inserting parking facilities:', insertError);
    return;
  }

  console.log(`Successfully inserted ${insertedFacilities.length} parking facilities!`);

  // Generate and insert initial congestion logs
  console.log('Generating initial congestion logs...');
  const logsToInsert = [];
  const nowIso = new Date().toISOString();

  for (const f of insertedFacilities) {
    const rand = Math.random();
    let level = 0.1;
    if (rand < 0.3) {
      level = Math.random() * 0.29; // 여유
    } else if (rand < 0.7) {
      level = 0.3 + Math.random() * 0.39; // 보통
    } else {
      level = 0.7 + Math.random() * 0.25; // 혼잡
    }
    level = Math.round(level * 100) / 100;
    const current_count = Math.round(f.capacity * level);

    logsToInsert.push({
      facility_id: f.id,
      congestion_level: level,
      current_count: current_count,
      source: 'iot_sensor',
      timestamp: nowIso
    });
  }

  console.log(`Inserting ${logsToInsert.length} congestion logs...`);
  const { error: logError } = await supabase
    .from('congestion_logs')
    .insert(logsToInsert);

  if (logError) {
    console.error('Error inserting congestion logs:', logError);
  } else {
    console.log('Successfully inserted initial congestion logs!');
  }
}

seedParking();
