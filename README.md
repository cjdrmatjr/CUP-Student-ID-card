# CUP 모바일 학생증

부산가톨릭대학교 모바일 학생증 웹앱. 로그인 세션을 유지하여 앱 실행만으로 QR 학생증을 바로 표시합니다.

## 실행 방법

```bash
# 1. 의존성 설치
cd backend && npm install

# 2. 서버 시작
npm start

# 3. 브라우저에서 접속
# http://localhost:3000
```

## 구조

```
backend/
  server.js        # Express 프록시 서버 (로그인, QR 세션 관리)
  package.json
frontend/
  index.html       # 모바일 최적화 UI (SPA)
```

## 동작 원리

1. 학번/비밀번호로 학교 서버에 로그인 → `CUPSESSIONID` 쿠키 획득
2. 세션을 서버 메모리에 유지 (1시간)
3. QR 요청 시 서버가 세션으로 학교 서버에 프록시 → 이미지 반환
4. QR은 60초마다 만료, 새로고침 버튼으로 갱신

## 배포

```bash
# 환경변수로 포트 설정 가능
PORT=8080 npm start
```

HTTPS 배포 시 reverse proxy (nginx 등) 사용 권장.
