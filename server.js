import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.loginTime > 3600000) sessions.delete(id);
  }
}, 600000);

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Login ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { userId, userPw } = req.body;
  if (!userId || !userPw) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요.' });
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

    // 실패: 짧은 alert 에러 (성공 메시지 제외)
    if (html.length < 500 && html.includes('alert') && !html.includes('처리되었습니다')) {
      const msg = html.match(/alert\(\s*'([^']+)'\s*\)/)?.[1] || '아이디 또는 비밀번호가 올바르지 않습니다.';
      return res.json({ success: false, message: msg });
    }

    // 성공: 메인 페이지에서 학생정보 추출
    let mainHtml = html;
    if (!mainHtml.includes('createQrCode')) {
      const mainRes = await client.get('https://www.cup.ac.kr/main.do');
      mainHtml = String(mainRes.data || '');
    }

    if (!mainHtml.includes('createQrCode')) {
      return res.json({ success: false, message: '학생증 정보를 찾을 수 없습니다.' });
    }

    const qr = mainHtml.match(/createQrCode\.do\?m_id=([^&"]+)/);
    const studentId = qr[1];
    const name = mainHtml.match(/<li>\s*<p>성\s*<span>.*?<\/span>명<\/p><em>([^<]+)<\/em>/)?.[1]?.trim() || '';
    const dept = mainHtml.match(/<li>\s*<p>학\s*<span>.*?<\/span>과<\/p><em>([^<]+)<\/em>/)?.[1]?.trim() || '';
    const birth = mainHtml.match(/<li>\s*<p>생년월일<\/p><em>([^<]+)<\/em>/)?.[1]?.trim() || '';
    const photo = mainHtml.match(/id="memberPhotoImg"[^>]*src="([^"]+)"/)?.[1] || '';

    const sessionId = genId();
    sessions.set(sessionId, { client, studentId, loginTime: Date.now() });

    res.json({
      success: true,
      sessionId,
      student: { studentId, name, department: dept, birthDate: birth, photoUrl: photo },
    });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ── QR Image Proxy ────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const { sessionId } = req.query;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(401).json({ success: false, message: '세션이 만료되었습니다.' });
  }

  try {
    const qrRes = await session.client.get(
      `https://www.cup.ac.kr/createQrCode.do?m_id=${session.studentId}&width=200&height=200&dummy=${Date.now()}`,
      { responseType: 'arraybuffer' }
    );
    res.set('Content-Type', qrRes.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(qrRes.data));
  } catch (err) {
    sessions.delete(sessionId);
    res.status(401).json({ success: false, message: '세션이 만료되었습니다.' });
  }
});

// ── Logout ────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  if (req.body.sessionId) sessions.delete(req.body.sessionId);
  res.json({ success: true });
});

// ── SPA fallback ──────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
