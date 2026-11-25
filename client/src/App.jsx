import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Overview from './pages/Overview.jsx';
import Curriculum from './pages/Curriculum.jsx';
import Schedule from './pages/Schedule.jsx';
import Intelligence from './pages/Intelligence.jsx';
import Sessions from './pages/Sessions.jsx';
import Assessments from './pages/Assessments.jsx';
import Feedback from './pages/Feedback.jsx';
import Gaps from './pages/Gaps.jsx';
import Settings from './pages/Settings.jsx';

export const AppContext = createContext({ health: null, refreshHealth: () => {} });
export const useAppContext = () => useContext(AppContext);

const NAV = [
  ['/', 'A', 'Overview'],
  ['/curriculum', 'B', 'Curriculum Explorer'],
  ['/schedule', 'C', 'Weekly Schedule'],
  ['/intelligence', 'D', 'Tutor Intelligence'],
  ['/sessions', 'E', 'Session History'],
  ['/assessments', 'F', 'Practical Assessments'],
  ['/feedback', 'G', 'Tutor Feedback'],
  ['/gaps', 'H', 'Gaps & Briefing'],
  ['/settings', 'I', 'Settings & Data'],
];

export function AiIndicator({ ai }) {
  if (!ai) return null;
  return (
    <span className={`badge ${ai.available ? 'good' : ''}`} title={ai.reason || `Using ${ai.model}`}>
      <span aria-hidden="true">{ai.available ? '●' : '○'}</span> AI {ai.available ? `on · ${ai.model}` : 'off'}
    </span>
  );
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.get('/health'));
      setHealthError(null);
    } catch (e) {
      setHealthError(e);
    }
  }, []);
  useEffect(() => {
    refreshHealth();
  }, [refreshHealth, location.pathname]);

  return (
    <AppContext.Provider value={{ health, refreshHealth }}>
      {health?.mode === 'demo' && (
        <div className="banner demo" role="status">
          DEMO MODE — you are viewing synthetic sample data in a separate database. Your real records are untouched. Turn off in Settings.
        </div>
      )}
      {healthError && (
        <div className="banner error" role="alert">
          Cannot reach the local API ({healthError.message}). Is the server running? Start it with <code>npm run dev</code>.
        </div>
      )}
      <div className="layout">
        <aside className="sidebar" aria-label="Main navigation">
          <div className="brand">
            Learning Studio
            <small>Vibe Coding &amp; AI Development · 12 weeks · 24 lessons</small>
          </div>
          <nav className="nav">
            {NAV.map(([to, key, text]) => (
              <NavLink key={to} to={to} end={to === '/'}>
                <span className="key" aria-hidden="true">{key}</span>
                {text}
              </NavLink>
            ))}
          </nav>
          <div style={{ padding: '16px 8px' }}>
            <AiIndicator ai={health?.ai} />
          </div>
        </aside>
        <div>
          <div className="mobile-nav">
            <label className="sr-only" htmlFor="mnav">Navigate</label>
            <select id="mnav" value={NAV.find(([to]) => to !== '/' && location.pathname.startsWith(to))?.[0] || '/'} onChange={(e) => navigate(e.target.value)}>
              {NAV.map(([to, , text]) => (
                <option key={to} value={to}>{text}</option>
              ))}
            </select>
          </div>
          <main className="main">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/curriculum" element={<Curriculum />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/schedule/:lessonId" element={<Schedule />} />
              <Route path="/intelligence" element={<Intelligence />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/sessions/:sessionId" element={<Sessions />} />
              <Route path="/assessments" element={<Assessments />} />
              <Route path="/assessments/:competencyId" element={<Assessments />} />
              <Route path="/feedback" element={<Feedback />} />
              <Route path="/gaps" element={<Gaps />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<p>Page not found.</p>} />
            </Routes>
          </main>
        </div>
      </div>
    </AppContext.Provider>
  );
}
