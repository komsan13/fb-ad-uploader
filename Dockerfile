FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=4000
EXPOSE 4000
# ตัวกลางหลายโปรไฟล์ — สตาร์ท server.js หนึ่งตัวต่อโปรไฟล์ (โปรไฟล์ TOP = ข้อมูลเดิมใน /data)
CMD ["node", "hub.js"]
