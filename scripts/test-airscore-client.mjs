/**
 * Quick test script for AirScore API client
 * Run with: node scripts/test-airscore-client.mjs
 * For local worker: LOCAL=1 node scripts/test-airscore-client.mjs
 */

// Parameters from URL: https://xc.highcloud.net/tracklog_map.html?trackid=43826&comPk=466&tasPk=2030
const comPk = 466;
const tasPk = 2030;
const trackId = '43826';

// Use production API (or localhost:8787 if worker is running locally)
const API_BASE = process.env.LOCAL ? 'http://localhost:8787' : 'https://taskscore.shonky.info';

async function testHealthCheck() {
  console.log('\n=== Testing Health Check ===');
  const url = `${API_BASE}/api/airscore`;
  console.log(`URL: ${url}`);
  try {
    const response = await fetch(url);
    console.log(`Status: ${response.status} ${response.statusText}`);
    const data = await response.text();
    console.log('Response:', data.substring(0, 500));
    return response.ok;
  } catch (error) {
    console.error('Error:', error.message);
    return false;
  }
}

async function testFetchTask() {
  console.log('\n=== Testing fetchAirScoreTask ===');
  const url = `${API_BASE}/api/airscore/task?comPk=${comPk}&tasPk=${tasPk}`;
  console.log(`URL: ${url}`);

  try {
    const response = await fetch(url);
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`Cache: ${response.headers.get('X-Cache') || 'N/A'}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response:', errorText);
      return null;
    }

    const data = await response.json();

    // Print summary of response
    console.log('\nCompetition Info:');
    console.log(`  Name: ${data.competition?.name}`);
    console.log(`  Class: ${data.competition?.class}`);
    console.log(`  Task: ${data.competition?.taskName}`);
    console.log(`  Date: ${data.competition?.date}`);
    console.log(`  Type: ${data.competition?.taskType}`);
    console.log(`  Distance: ${data.competition?.taskDistance} km`);

    console.log('\nTask structure keys:', Object.keys(data.task || {}));
    console.log('Turnpoints:');
    const turnpoints = data.task?.turnpoints || [];
    if (turnpoints.length > 0) {
      turnpoints.forEach((tp, i) => {
        const wpName = tp.waypoint?.name || tp.name || 'unnamed';
        const wpType = tp.type || 'waypoint';
        const radius = tp.radius || 'N/A';
        console.log(`  ${i + 1}. ${wpName} (${wpType}) - radius: ${radius}m`);
      });
    }
    if (data.task?.sss) {
      console.log(`  SSS: radius=${data.task.sss.radius}m, direction=${data.task.sss.direction}`);
    }
    if (data.task?.goal) {
      console.log(`  Goal: radius=${data.task.goal.radius}m, type=${data.task.goal.type}`);
    }

    console.log(`\nPilots: ${data.pilots?.length || 0} entries`);
    if (data.pilots?.length > 0) {
      console.log('Top 5:');
      data.pilots.slice(0, 5).forEach(p => {
        console.log(`  ${p.rank}. ${p.name} - ${p.score} pts (${p.distance} km)`);
      });
    }

    console.log('\nFormula:');
    console.log(`  Name: ${data.formula?.name}`);
    console.log(`  Nominal Distance: ${data.formula?.nominalDistance}`);
    console.log(`  Nominal Time: ${data.formula?.nominalTime}`);

    return data;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

async function testFetchTrack() {
  console.log('\n=== Testing fetchAirScoreTrack ===');
  const url = `${API_BASE}/api/airscore/track?trackId=${trackId}&comPk=${comPk}&tasPk=${tasPk}`;
  console.log(`URL: ${url}`);

  try {
    const response = await fetch(url);
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`Cache: ${response.headers.get('X-Cache') || 'N/A'}`);
    console.log(`Content-Type: ${response.headers.get('Content-Type')}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response:', errorText);
      return null;
    }

    const igcContent = await response.text();

    // Print summary of IGC file
    const lines = igcContent.split('\n');
    console.log(`\nIGC file: ${lines.length} lines, ${igcContent.length} bytes`);

    // Show header info
    console.log('\nIGC Header (first 20 lines):');
    lines.slice(0, 20).forEach(line => {
      if (line.startsWith('H')) {
        console.log(`  ${line.trim()}`);
      }
    });

    // Count B records (fixes)
    const bRecords = lines.filter(l => l.startsWith('B'));
    console.log(`\nFix records (B): ${bRecords.length}`);
    if (bRecords.length > 0) {
      console.log(`  First: ${bRecords[0].substring(0, 35)}...`);
      console.log(`  Last:  ${bRecords[bRecords.length - 1].substring(0, 35)}...`);
    }

    return igcContent;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

// Run all tests
async function main() {
  console.log('Testing AirScore API Client');
  console.log(`API Base: ${API_BASE}`);
  console.log(`Parameters: comPk=${comPk}, tasPk=${tasPk}, trackId=${trackId}`);

  await testHealthCheck();
  await testFetchTask();
  await testFetchTrack();

  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
