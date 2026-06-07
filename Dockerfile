FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package.json .
RUN npm install --production

# 复制代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 8080

# 设置环境变量（可以通过 docker run -e 覆盖）
ENV PORT=8080
ENV HF_USER=""
ENV API_KEY="your_api_key_here"
ENV DATA_DIR="/app/data"
ENV LOG_LEVEL="info"

# 数据卷（用于持久化配置）
VOLUME ["/app/data"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# 启动应用
CMD ["npm", "start"]
