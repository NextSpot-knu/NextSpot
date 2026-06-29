const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://xdwnwrthrgflbzpvkouq.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY. Run with: node --env-file=.env.local scripts/seed.js");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Timezone offset for KST (UTC + 9 hours)
const KST_OFFSET = 9 * 60 * 60 * 1000;

function getKstDate(offsetDays = 0, hour = 0, minute = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + KST_OFFSET);
  
  const target = new Date(kst);
  target.setDate(kst.getDate() + offsetDays);
  target.setHours(hour, minute, 0, 0);
  
  // Convert back to UTC for DB storage
  return new Date(target.getTime() - KST_OFFSET);
}

async function seed() {
  console.log('Starting DB Seeding...');

  // 1. Fetch existing facilities and users
  const { data: facilities, error: fErr } = await supabase.from('facilities').select('*');
  if (fErr || !facilities || facilities.length === 0) {
    console.error('No facilities found to seed data for. Please check DB.', fErr);
    return;
  }
  console.log(`Found ${facilities.length} facilities.`);

  const { data: users, error: uErr } = await supabase.from('users').select('*');
  if (uErr || !users || users.length === 0) {
    console.error('No users found. Creating mock users first...');
    // Create 5 mock users if they don't exist
    const { data: newUsers } = await supabase.from('users').insert([
      { employee_id: 'EMP001', company_name: '삼성전자', preferred_categories: ['cafeteria', 'gym'], work_shift: 'day', role: 'user' },
      { employee_id: 'EMP002', company_name: '삼성전자', preferred_categories: ['cafeteria', 'cafe'], work_shift: 'day', role: 'user' },
      { employee_id: 'EMP003', company_name: '하이닉스', preferred_categories: ['gym', 'cafe'], work_shift: 'night', role: 'user' },
      { employee_id: 'EMP004', company_name: '하이닉스', preferred_categories: ['cafeteria'], work_shift: 'day', role: 'user' },
      { employee_id: 'EMP005', company_name: '협력사A', preferred_categories: ['cafeteria', 'gym'], work_shift: 'day', role: 'user' }
    ]).select();
    users.push(...(newUsers || []));
  }
  console.log(`Active users count: ${users.length}`);

  // 2. Clear old logs, recommendations, and feedback to prevent duplicates and starts clean
  console.log('Clearing old logs, recommendations, and feedbacks...');
  await supabase.from('user_feedback').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('recommendations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('congestion_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  console.log('Old records cleared.');

  // 3. Generate Congestion Logs (Past 30 days)
  console.log('Generating congestion logs for the past 30 days...');
  const logsToInsert = [];
  
  // Categorize facilities to apply realistic patterns
  // Examples: 식당 (Restaurant), 체육관/헬스장 (Gym), 카페 (Cafe), 휴게실 (Lounge), 사무실 (Office)
  const categorizedFacilities = facilities.map(f => {
    let type = 'office';
    if (f.name.includes('식당') || f.name.includes('뷔페') || f.type === 'restaurant' || f.type === 'cafeteria') {
      type = 'restaurant';
    } else if (f.name.includes('체육') || f.name.includes('헬스') || f.name.includes('피트니스') || f.type === 'gym') {
      type = 'gym';
    } else if (f.name.includes('카페') || f.name.includes('커피') || f.type === 'cafe') {
      type = 'cafe';
    }
    return { ...f, facilityType: type };
  });

  // Helper to determine congestion level by hour and facility type
  function getCongestion(type, hour) {
    let base = 0.15;
    if (type === 'restaurant') {
      if (hour >= 11 && hour <= 13) base = 0.75 + Math.random() * 0.15; // 점심 피크
      else if (hour >= 17 && hour <= 19) base = 0.60 + Math.random() * 0.20; // 저녁 피크
      else base = 0.05 + Math.random() * 0.1;
    } else if (type === 'gym') {
      if (hour >= 7 && hour <= 9) base = 0.45 + Math.random() * 0.15; // 아침 운동
      else if (hour >= 18 && hour <= 21) base = 0.70 + Math.random() * 0.22; // 퇴근 후 운동 피크 (이상 혼잡 발생 유도)
      else base = 0.1 + Math.random() * 0.15;
    } else if (type === 'cafe') {
      if (hour === 8 || hour === 13 || hour === 15) base = 0.65 + Math.random() * 0.20; // 출근 및 휴식시간 피크
      else base = 0.20 + Math.random() * 0.15;
    } else { // Office / General
      if (hour >= 9 && hour <= 18) base = 0.40 + Math.random() * 0.25; // 업무 시간 일정한 흐름
      else base = 0.05 + Math.random() * 0.1;
    }
    return Math.min(Math.max(base, 0), 1);
  }

  // Generate hourly logs for today (0-23 hours) for heatmap completeness
  for (const f of categorizedFacilities) {
    for (let h = 0; h < 24; h++) {
      const timestamp = getKstDate(0, h, 0);
      const congestion_level = getCongestion(f.facilityType, h);
      const current_count = Math.round(f.capacity * congestion_level);
      
      logsToInsert.push({
        facility_id: f.id,
        timestamp: timestamp.toISOString(),
        current_count,
        congestion_level: Math.round(congestion_level * 100) / 100,
        source: 'iot_sensor'
      });
    }
  }

  // Generate historical logs (past 1 to 29 days).
  // To avoid huge payloads, insert logs every 3 hours for the past 29 days.
  for (let d = -29; d < 0; d++) {
    for (const f of categorizedFacilities) {
      // 4 points per day: 9:00, 12:00, 15:00, 18:00
      const hours = [9, 12, 15, 18];
      for (const h of hours) {
        const timestamp = getKstDate(d, h, 0);
        const congestion_level = getCongestion(f.facilityType, h);
        const current_count = Math.round(f.capacity * congestion_level);
        
        logsToInsert.push({
          facility_id: f.id,
          timestamp: timestamp.toISOString(),
          current_count,
          congestion_level: Math.round(congestion_level * 100) / 100,
          source: 'iot_sensor'
        });
      }
    }
  }

  // Insert Congestion Logs in batches of 1000
  console.log(`Inserting ${logsToInsert.length} congestion logs...`);
  const batchSize = 1000;
  for (let i = 0; i < logsToInsert.length; i += batchSize) {
    const batch = logsToInsert.slice(i, i + batchSize);
    const { error } = await supabase.from('congestion_logs').insert(batch);
    if (error) {
      console.error('Error inserting congestion logs batch:', error);
      return;
    }
    console.log(`Inserted logs ${i} to ${Math.min(i + batchSize, logsToInsert.length)}`);
  }

  // 4. Generate Anomaly Alerts for Today (Explicitly insert high congestion records)
  // Let's create an anomaly for the Gym (fitness center) and one Cafeteria today
  console.log('Injecting explicit anomalies for today...');
  const gym = categorizedFacilities.find(f => f.facilityType === 'gym');
  const restaurant = categorizedFacilities.find(f => f.facilityType === 'restaurant');

  const anomalyLogs = [];
  if (gym) {
    // Gym anomaly from 18:30 to 19:45 today (duration 75 mins)
    const times = [30, 45, 60, 75]; // offsets in minutes from 18:00
    for (const t of times) {
      const timestamp = getKstDate(0, 18, t);
      anomalyLogs.push({
        facility_id: gym.id,
        timestamp: timestamp.toISOString(),
        current_count: Math.round(gym.capacity * 0.95),
        congestion_level: 0.95,
        source: 'iot_sensor'
      });
    }
  }

  if (restaurant) {
    // Restaurant anomaly from 12:00 to 12:45 today (duration 45 mins)
    const times = [0, 15, 30, 45];
    for (const t of times) {
      const timestamp = getKstDate(0, 12, t);
      anomalyLogs.push({
        facility_id: restaurant.id,
        timestamp: timestamp.toISOString(),
        current_count: Math.round(restaurant.capacity * 0.92),
        congestion_level: 0.92,
        source: 'iot_sensor'
      });
    }
  }

  if (anomalyLogs.length > 0) {
    const { error: aErr } = await supabase.from('congestion_logs').insert(anomalyLogs);
    if (aErr) console.error('Error inserting anomalies:', aErr);
    else console.log('Anomalies successfully injected.');
  }

  // 5. Generate Recommendations and User Feedbacks (Past 30 days)
  console.log('Generating recommendations and user feedback for the past 30 days...');
  const recsToInsert = [];
  
  // Find pairable facilities of the same type
  const restaurants = categorizedFacilities.filter(f => f.facilityType === 'restaurant');
  const gyms = categorizedFacilities.filter(f => f.facilityType === 'gym');
  const cafes = categorizedFacilities.filter(f => f.facilityType === 'cafe');

  for (let d = -29; d <= 0; d++) {
    // 10 recommendations per day
    const recsPerDay = 10;
    for (let r = 0; r < recsPerDay; r++) {
      const user = users[Math.floor(Math.random() * users.length)];
      
      // Determine type of recommendation
      const randType = Math.random();
      let original, recommended;
      
      if (randType < 0.5 && restaurants.length >= 2) {
        original = restaurants[0];
        recommended = restaurants[1];
      } else if (randType < 0.8 && gyms.length >= 2) {
        original = gyms[0];
        recommended = gyms[1];
      } else if (cafes.length >= 2) {
        original = cafes[0];
        recommended = cafes[1];
      } else {
        original = facilities[0];
        recommended = facilities[1];
      }

      if (!original || !recommended || original.id === recommended.id) continue;

      const hour = Math.floor(Math.random() * 12) + 8; // Between 8:00 and 20:00
      const created_at = getKstDate(d, hour, Math.floor(Math.random() * 60));
      const accepted = Math.random() < 0.75; // 75% accept rate

      recsToInsert.push({
        user_id: user.id,
        original_facility_id: original.id,
        recommended_facility_id: recommended.id,
        tttv_score: Math.round((60 + Math.random() * 35) * 10) / 10,
        score_breakdown: { distance: 10, congestion_reduction: 15 },
        accepted,
        created_at: created_at.toISOString()
      });
    }
  }

  // Insert Recommendations
  const { data: insertedRecs, error: rErr } = await supabase
    .from('recommendations')
    .insert(recsToInsert)
    .select();

  if (rErr || !insertedRecs) {
    console.error('Error inserting recommendations:', rErr);
    return;
  }
  console.log(`Inserted ${insertedRecs.length} recommendations.`);

  // 6. Generate corresponding User Feedbacks
  const feedbackToInsert = [];
  for (const rec of insertedRecs) {
    feedbackToInsert.push({
      user_id: rec.user_id,
      recommendation_id: rec.id,
      action: rec.accepted ? 'accepted' : (Math.random() < 0.5 ? 'rejected' : 'ignored'),
      timestamp: rec.created_at
    });
  }

  // Insert Feedbacks
  const { error: fbErr } = await supabase.from('user_feedback').insert(feedbackToInsert);
  if (fbErr) {
    console.error('Error inserting user feedback:', fbErr);
    return;
  }
  console.log(`Inserted ${feedbackToInsert.length} user feedbacks.`);

  console.log('DB Seeding Completed Successfully! 🚀');
}

seed();
