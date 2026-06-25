// https://fakerjs.dev/guide/
// Generate 1,000,000 records

const { faker } = require('@faker-js/faker');
const fs = require('fs');
const path = require('path');

const TOTAL = 1_000_000;
const BATCH_SIZE = 10_000;
const OUTPUT_FILE = path.join(__dirname, 'data.csv');

const writeStream = fs.createWriteStream(OUTPUT_FILE);
writeStream.write('firstname,lastname,address\n');

let written = 0;

function generateBatch(size) {
  const lines = [];
  for (let i = 0; i < size; i++) {
    const firstname = faker.person.firstName().replace(/,/g, '');
    const lastname = faker.person.lastName().replace(/,/g, '');
    const address = faker.location.streetAddress({ useFullAddress: true }).replace(/,/g, ' ');
    lines.push(`${firstname},${lastname},${address}`);
  }
  return lines.join('\n') + '\n';
}

function run() {
  let remaining = TOTAL;

  function writeBatch() {
    while (remaining > 0) {
      const batchSize = Math.min(BATCH_SIZE, remaining);
      const chunk = generateBatch(batchSize);
      remaining -= batchSize;
      written += batchSize;

      if (written % 100_000 === 0) {
        process.stdout.write(`Progress: ${written.toLocaleString()} / ${TOTAL.toLocaleString()}\n`);
      }

      const ok = writeStream.write(chunk);
      if (!ok) {
        writeStream.once('drain', writeBatch);
        return;
      }
    }

    writeStream.end(() => {
      console.log(`Done! ${TOTAL.toLocaleString()} records written to ${OUTPUT_FILE}`);
    });
  }

  writeBatch();
}

run();
