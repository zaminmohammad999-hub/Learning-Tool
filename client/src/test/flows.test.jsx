import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App.jsx';
import AnalysisReview from '../components/AnalysisReview.jsx';

const health = { ok: true, mode: 'real', counts: { exercises: 96 }, ai: { available: false, key_configured: false, model: 'claude-opus-5-5', reason: 'ANTHROPIC_API_KEY is not set' } };
const lesson = (n, status = 'planned') => ({ id: `L${String(n).padStart(2, '0')}`, number: n, title: `Lesson ${n}`, status, planned_date: null, coverage: { covered: n === 6 ? 1 : 0, total: 4 }, mastery_state: 'not_assessed', transcript_count: 0, domain_assessment_after: n % 4 === 0 ? `DA-D${n / 4}` : null });
const stats = {
  today: '2026-11-23',
  programme: { title: 'Vibe Coding & AI Development Mastery' },
  coverage: { covered: 1, total: 96, percent: 1, status_counts: {} },
  mastery: { verified_passed: 0, total: 24, percent: 0, state_counts: {} },
  lessons: { planned: 24, held: 0, missed: 0, total: 24 },
  next_lesson: lesson(1),
  domains: [
    { id: 'D2', name: 'Git & GitHub Version Control', coverage: { covered: 1, total: 16 }, mastered: 0, competencies: [{ id: 'D2-C2', title: 'Remote repository operations', lesson_id: 'L06', lesson_number: 6, coverage: { covered: 1, total: 4 }, mastery_state: 'not_assessed', criteria: '0/4' }], domain_assessment: { id: 'DA-D2', latest_result: null } },
  ],
  timeline: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, lessons: [lesson(i * 2 + 1), lesson(i * 2 + 2)] })),
  overdue: [],
  warnings: [{ type: 'pending_review', message: '2 proposed transcript match(es) are awaiting your review.' }],
  recent_sessions: [],
  recent_attempts: [],
};

function mockFetch(routes) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const body = key ? (typeof routes[key] === 'function' ? routes[key](path, opts) : routes[key]) : { error: 'not mocked' };
    return new Response(JSON.stringify(body), { status: key ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

describe('Overview', () => {
  it('shows coverage and verified mastery as separate metrics, plus the 12-week timeline', async () => {
    mockFetch({ '/health': health, '/dashboard/stats': stats });
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    expect((await screen.findAllByText('Exercise coverage')).length).toBeGreaterThan(0);
    expect(screen.getByText('Verified mastery')).toBeInTheDocument();
    expect(screen.getByText('/ 96 exercises (1%)')).toBeInTheDocument();
    expect(screen.getByText('/ 24 competencies')).toBeInTheDocument();
    expect(screen.getAllByText(/^W\d+$/)).toHaveLength(12);
    expect(screen.getByText(/awaiting your review/)).toBeInTheDocument();
    expect(screen.getAllByText(/AI off/).length).toBeGreaterThan(0);
  });
});

describe('Transcript review', () => {
  const analysis = {
    id: 7,
    version: 1,
    method: 'rule_based',
    created_at: '2026-11-23T10:00:00Z',
    transcript_id: 3,
    status: 'completed',
    warnings: [],
    gaps: [{ exercise_id: 'D2-C2-E3', facet: 'git fetch', message: 'git fetch — not evidenced in this transcript (part of D2-C2-E3).' }],
    extraction: null,
    matches: [
      { id: 11, exercise_id: 'D2-C2-E2', exercise_description: 'Clone a repository to the computer.', category: 'demonstrated', confidence: 0.84, rationale: 'Command executed', snippet: 'git clone https://github.com/example/x.git', timecode: '00:03:40', speaker: 'Learner', review_status: 'pending', current_status: 'not_started', facets: null, extra_snippets: [] },
      { id: 12, exercise_id: 'D2-C2-E4', exercise_description: 'Inspect git remote -v…', category: 'uncertain', confidence: 0.25, rationale: 'Planned for later', snippet: "We'll look at git remote -v next session.", timecode: '00:05:20', speaker: 'Tutor', review_status: 'pending', current_status: 'not_started', facets: null, extra_snippets: [] },
    ],
  };

  it('shows suggestion → curriculum item → cited evidence and posts an explicit approval', async () => {
    const calls = mockFetch({ '/matches/11/decision': { match: { id: 11 } } });
    const onDecided = vi.fn();
    render(<MemoryRouter><AnalysisReview analysis={analysis} onDecided={onDecided} /></MemoryRouter>);
    expect(screen.getByText(/git fetch — not evidenced/)).toBeInTheDocument();
    expect(screen.getByText(/git clone https:\/\/github.com\/example\/x.git/)).toBeInTheDocument();
    const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
    expect(approveButtons[1]).toBeDisabled(); // uncertain matches cannot be approved as-is
    fireEvent.click(approveButtons[0]);
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(calls.find((c) => c.path === '/matches/11/decision')).toMatchObject({ method: 'POST', body: { decision: 'approve' } });
  });
});

describe('Practical assessment', () => {
  it('previews FAIL when any mandatory criterion is assisted and PASS only when all count', async () => {
    const criteria = ['E1', 'E2', 'E3', 'E4'].map((e, i) => ({ id: `RC-D2-C2-${e}`, text: `Criterion ${i + 1}`, mandatory: 1, active: 1, exercise_id: `D2-C2-${e}`, seed_text: `Criterion ${i + 1}` }));
    const comp = {
      id: 'D2-C2', title: 'Remote repository operations', domain_id: 'D2', domain_name: 'Git', lesson_id: 'L06', lesson_number: 6, week: 3,
      rubric: { id: 'RUB-D2-C2', criteria },
      mastery: { state: 'not_assessed', best_criteria_passed: 0, mandatory_count: 4, attempts: 0, verifiable_attempt_id: null, note: null },
    };
    mockFetch({
      '/health': health,
      '/assessments/attempts': [],
      '/assessments': { competencies: [comp], domain_assessments: [{ id: 'DA-D2', domain_id: 'D2', after_lesson_id: 'L08', week: 4, latest_result: null, rubric: { id: 'RUB-DA-D2', criteria: [] } }], skill_checks_due: [] },
    });
    render(<MemoryRouter initialEntries={['/assessments/D2-C2']}><App /></MemoryRouter>);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    rows.forEach((row) => {
      fireEvent.change(within(row).getByLabelText('Result'), { target: { value: 'pass' } });
      fireEvent.change(within(row).getByLabelText('Evidence text'), { target: { value: 'seen live' } });
    });
    expect(screen.getByText(/Preview: PASS · 4\/4/)).toBeInTheDocument();
    fireEvent.change(within(rows[2]).getByLabelText('Independence'), { target: { value: 'assisted' } });
    expect(screen.getByText(/Preview: FAIL · 3\/4/)).toBeInTheDocument();
    fireEvent.change(within(rows[2]).getByLabelText('Independence'), { target: { value: 'independent' } });
    fireEvent.change(within(rows[0]).getByLabelText('Evidence type'), { target: { value: 'transcript_only' } });
    expect(screen.getByText(/Preview: FAIL · 3\/4/)).toBeInTheDocument();
    expect(screen.getByText(/Verify Pass becomes available/)).toBeInTheDocument();
  });
});
