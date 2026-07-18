@echo off
chcp 65001 >nul
REM ==== Deploy fb-ad-uploader -> https://ad.senball.com (ดับเบิลคลิกได้เลย) ====
REM ขั้นตอน: push โค้ดขึ้น GitHub -> ให้เซิร์ฟเวอร์ pull + build + รัน container ใหม่ (รหัสผ่านเว็บคงเดิม)
cd /d "%~dp0"

echo === [1/2] push ขึ้น GitHub ===
git push origin master
if errorlevel 1 (
  echo.
  echo push ไม่สำเร็จ — เช็คว่า commit แล้วหรือยัง / เน็ตปกติไหม
  pause
  exit /b 1
)

echo === [2/2] deploy ไปที่เซิร์ฟเวอร์ ad.senball.com ===
ssh -i "%USERPROFILE%\.ssh\ball_deploy" root@31.97.105.21 "cd /opt/fb-ad-uploader && git pull --ff-only && bash redeploy.sh"
if errorlevel 1 (
  echo.
  echo deploy ไม่สำเร็จ — อ่าน error ด้านบน
  pause
  exit /b 1
)

echo.
echo เสร็จแล้ว! เปิด https://ad.senball.com แล้วกด Ctrl+F5
pause
