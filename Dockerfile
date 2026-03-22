FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN pip install --no-cache-dir -e .

EXPOSE 8080

# Default to SSE for container deployments; override with CMD for stdio
ENTRYPOINT ["python", "-m", "jira_dc_mcp"]
CMD ["--transport", "sse", "--port", "8080"]
