# Grafana dashboard image for a Perxel MCP (section 3.12 of the task list).
#
# Build with the repo root as context so the clone's own dashboards/ extras
# bake in next to the kit base dashboard:
#   docker build -f kit/dashboard/Dockerfile -t mcp-dash:dev .
# The dashboard Worker (kit/dashboard/worker.ts) points Wrangler at this file
# with image_build_context "." for the same reason. Clones never edit this
# file; their extras live in the repo-root dashboards/ dir.
#
# The per-client dataset (mcp_<slug>) is stamped in at build time:
#   docker build --build-arg DATASET=mcp_khatra ...
# or via image_vars in wrangler.dash.jsonc (the clone owns that file).
# Default is the template's own dataset so the template builds unmodified.
ARG DATASET=mcp_example

# Pinned exact tag, never `latest`. Note: Grafana froze the grafana-oss repo
# after 12.4.0 (13.0.2 is its newest tag); grafana/grafana holds the same OSS
# bytes and keeps receiving updates — switch if this tag goes stale.
FROM grafana/grafana-oss:13.0.2

# Pinned Altinity ClickHouse plugin (Cloudflare's documented way to query
# Analytics Engine from Grafana).
RUN grafana-cli plugins install vertamedia-clickhouse-datasource 3.4.11

COPY kit/dashboard/provisioning /etc/grafana/provisioning
COPY kit/dashboard/dashboards /var/lib/grafana/dashboards/kit
COPY dashboards /var/lib/grafana/dashboards/clone

# Point the base dashboard at this client's dataset (clone extras already use
# the right name; only the kit template says mcp_example).
RUN if [ "${DATASET}" != "mcp_example" ]; then \
      grep -rl 'mcp_example' /var/lib/grafana/dashboards/kit | xargs sed -i "s/mcp_example/${DATASET}/g"; \
    fi

# GF_SERVER_ROOT_URL is set at container runtime by kit/dashboard/worker.ts
# (https://dash.perxel.com/<slug>/); the default below only covers plain
# `docker run` local checks.
ENV GF_SERVER_ROOT_URL=https://dash.perxel.com/example/ \
    GF_SERVER_SERVE_FROM_SUB_PATH=true \
    GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
    GF_AUTH_DISABLE_LOGIN_FORM=true \
    GF_EXPLORE_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_PATHS_PROVISIONING=/etc/grafana/provisioning

EXPOSE 3000
