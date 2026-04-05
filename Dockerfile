FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY data ./data
COPY public ./public
COPY src ./src
COPY .env.example ./.env.example
COPY docker-assets/skills ./bundled-skills
COPY docker-entrypoint.sh /usr/local/bin/job-visualizer-entrypoint.sh

RUN chmod +x /usr/local/bin/job-visualizer-entrypoint.sh

ENV NODE_ENV=production
ENV SKILL_OUTPUT_ROOT=/app/runtime-skills/jphr/outputs/japan-frontend-jobs
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/job-visualizer-entrypoint.sh"]
CMD ["npm", "run", "start"]
