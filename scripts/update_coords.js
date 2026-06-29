const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'samples', 'gumi_parking_private.csv');
const csvContent = fs.readFileSync(csvPath, 'utf-8');

// Parse CSV manually
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

// Convert rows back to CSV
function toCSV(rows) {
  return rows.map(row => 
    row.map(cell => {
      let cellStr = String(cell);
      if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
        return '"' + cellStr.replace(/"/g, '""') + '"';
      }
      return cellStr;
    }).join(',')
  ).join('\n');
}

const rows = parseCSV(csvContent);
const headers = rows[0];
const dataRows = rows.slice(1);

const latMin = 36.090003;
const latMax = 36.120196;
const lngMin = 128.366930;
const lngMax = 128.386967;

// Distribute them evenly using a simple grid approach or random uniform
// Let's use uniform random distribution
for (let i = 0; i < dataRows.length; i++) {
  if (dataRows[i].length < 5) continue;
  
  // To make it look a bit organized, let's use a seeded random or just Math.random()
  const randomLat = latMin + Math.random() * (latMax - latMin);
  const randomLng = lngMin + Math.random() * (lngMax - lngMin);
  
  dataRows[i][3] = randomLat.toFixed(6); // latitude
  dataRows[i][4] = randomLng.toFixed(6); // longitude
}

const outputCSV = toCSV([headers, ...dataRows]);
fs.writeFileSync(csvPath, outputCSV, 'utf-8');
console.log('Coordinates have been updated successfully.');
