@echo off
chcp 65001 >nul
REM ==== Deploy fb-ad-uploader -> https://ad.senball.com (ดับเบิลคลิกได้เลย) ====
REM ขั้นตอน: push โค้ดขึ้น GitHub -> ให้ server สร้าง release worktree ที่ commit เดียวกันแล้ว deploy
REM ไม่ใช้ checkout หลักบน server โดยตรง เพราะอาจมีไฟล์แก้ค้างอยู่และทำให้ git pull --ff-only ล้มเหลว
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
ssh -i "%USERPROFILE%\.ssh\ball_deploy" root@31.97.105.21 "set -euo pipefail; repo=/opt/fb-ad-uploader; releases=/opt/fbad-releases; git -C $repo fetch origin master; sha=$(git -C $repo rev-parse origin/master); release=$releases/$sha; mkdir -p $releases; if [ ! -d $release ]; then git -C $repo worktree add --detach $release $sha; fi; bash -n $release/redeploy.sh; bash $release/redeploy.sh"
if errorlevel 1 (
  echo.
  echo deploy ไม่สำเร็จ — อ่าน error ด้านบน
  pause
  exit /b 1
)

echo.
echo เสร็จแล้ว! เปิด https://ad.senball.com แล้วกด Ctrl+F5
pause
