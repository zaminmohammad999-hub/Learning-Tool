import { loadCurriculumFile, validateCurriculum } from '../db/curriculum.js';

const { json, checksum } = loadCurriculumFile();
const v = validateCurriculum(json);
console.log(`Curriculum checksum: ${checksum}`);
console.log('Counts:', v.counts);
if (v.ok) {
  console.log('OK — 6 domains, 24 competencies, 96 exercises, 12 weeks, 24 lessons (2/week, 60 min), no duplicate or dangling ids.');
} else {
  console.error('Validation FAILED:\n- ' + v.errors.join('\n- '));
  process.exit(1);
}
