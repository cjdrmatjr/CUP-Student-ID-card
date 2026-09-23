import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── 신뢰 프록시 (Render, Nginx 등 뒤에서 실행 시) ──────
app.set('trust proxy', 1);

// ── 보안 헤더 ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "blob:", "https://univ.cup.ac.kr"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── CORS (같은 오리진만 허용) ─────────────────────────
app.use(cors({ origin: false }));

// ── 요청 크기 제한 ────────────────────────────────────
app.use(express.json({ limit: '1kb' }));

// ── 정적 파일 ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend')));

// ── 로그인 Rate Limit (IP당 15분에 10회) ──────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.' },
});

// ── 실패 카운터 (IP별) ────────────────────────────────
const failCount = new Map(); // ip -> { count, until }
const LOCK_THRESHOLD = 5;
const LOCK_DURATION = 10 * 60 * 1000; // 10분

function checkBruteForce(ip) {
  const entry = failCount.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    failCount.delete(ip);
    return false;
  }
  return entry.count >= LOCK_THRESHOLD;
}

function recordFailure(ip) {
  const entry = failCount.get(ip) || { count: 0, until: Date.now() + LOCK_DURATION };
  entry.count++;
  entry.until = Date.now() + LOCK_DURATION;
  failCount.set(ip, entry);
}

function clearFailures(ip) {
  failCount.delete(ip);
}

// ── 세션 관리 ─────────────────────────────────────────
const sessions = new Map();

// 만료 세션 정리 (10분마다)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.loginTime > 3600000) sessions.delete(id);
  }
  for (const [ip, entry] of failCount) {
    if (Date.now() > entry.until) failCount.delete(ip);
  }
}, 600000);

// ── 입력 검증 ─────────────────────────────────────────
function sanitize(input, maxLen = 20) {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, maxLen).replace(/[<>"'&]/g, '');
}

// ── 로그인 ────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  const ip = req.ip;
  const userId = sanitize(req.body.userId, 20);
  const userPw = req.body.userPw;

  if (!userId || !userPw || typeof userPw !== 'string') {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요.' });
  }

  if (userPw.length > 50) {
    return res.status(400).json({ success: false, message: '비밀번호가 너무 깁니다.' });
  }

  // 무차별 대입 방지
  if (checkBruteForce(ip)) {
    return res.status(429).json({ success: false, message: '로그인 실패 횟수 초과. 10분 후 다시 시도하세요.' });
  }

  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    maxRedirects: 10,
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://www.cup.ac.kr/login/login.do',
      'Origin': 'https://www.cup.ac.kr',
    },
  }));

  try {
    const loginRes = await client.post(
      'https://www.cup.ac.kr/certi/loginProc.do',
      new URLSearchParams({ userType: '2', userId, userPw }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const html = String(loginRes.data || '');

    // 실패 감지
    if (html.length < 500 && html.includes('alert') && !html.includes('처리되었습니다')) {
      recordFailure(ip);
      const msg = html.match(/alert\(\s*'([^']+)'\s*\)/)?.[1] || '아이디 또는 비밀번호가 올바르지 않습니다.';
      return res.json({ success: false, message: msg });
    }

    // 성공 시 실패 카운터 초기화
    clearFailures(ip);

    let mainHtml = html;
    if (!mainHtml.includes('createQrCode')) {
      const mainRes = await client.get('https://www.cup.ac.kr/main.do');
      mainHtml = String(mainRes.data || '');
    }

    if (!mainHtml.includes('createQrCode')) {
      return res.json({ success: false, message: '학생증 정보를 찾을 수 없습니다.' });
    }

    const qr = mainHtml.match(/createQrCode\.do\?m_id=([^&"]+)/);
    const studentId = sanitize(qr[1], 20);
    const name = mainHtml.match(/<li>\s*<p>성\s*<span>.*?<\/span>명<\/p><em>([^<]+)<\/em>/)?.[1]?.trim() || '';
    const dept = mainHtml.match(/<li>\s*<p>학\s*<span>.*?<\/span>과<\/p><em>([^<]+)<\/em>/)?.[1]?.trim() || '';
    const birth = mainHtml.match(/<li>\s*<p>생년월일<\/p><em>([^<]+)<\/em>/)?.[1]?.trim() || '';
    const photo = mainHtml.match(/id="memberPhotoImg"[^>]*src="([^"]+)"/)?.[1] || '';

    // 암호학적으로 안전한 세션 ID
    const sessionId = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, { client, studentId, loginTime: Date.now() });

    res.json({
      success: true,
      sessionId,
      student: { studentId, name, department: dept, birthDate: birth, photoUrl: photo },
    });
  } catch (err) {
    console.error('[LOGIN] server error');
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ── QR 이미지 프록시 ──────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const sessionId = sanitize(req.query.sessionId, 64);
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(401).json({ success: false, message: '세션이 만료되었습니다.' });
  }

  // 세션 만료 확인 (1시간)
  if (Date.now() - session.loginTime > 3600000) {
    sessions.delete(sessionId);
    return res.status(401).json({ success: false, message: '세션이 만료되었습니다.' });
  }

  try {
    const qrRes = await session.client.get(
      `https://www.cup.ac.kr/createQrCode.do?m_id=${session.studentId}&width=200&height=200&dummy=${Date.now()}`,
      { responseType: 'arraybuffer' }
    );
    res.set('Content-Type', qrRes.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(qrRes.data));
  } catch (err) {
    sessions.delete(sessionId);
    res.status(401).json({ success: false, message: '세션이 만료되었습니다.' });
  }
});

// ── 로그아웃 ──────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const sessionId = sanitize(req.body.sessionId, 64);
  if (sessionId) sessions.delete(sessionId);
  res.json({ success: true });
});

// ── SPA fallback ──────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
