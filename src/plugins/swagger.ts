import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { createJsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

export default fp(async function swaggerPlugin(app: FastifyInstance) {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Algihaz LCMS API',
        description: 'Backend API for the Algihaz Legal Case Management System.',
        version: '1.0.0',
      },
      servers: [{ url: '/', description: 'Current server' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'lcms_access' },
        },
      },
    },
    // Zod's .email() emits both `format: "email"` and a verbose validation
    // `pattern`. Swagger UI's "Try it out" auto-fill generates its example
    // value from `pattern` when present (via a regex-expanding generator),
    // producing an unreadable random string that technically matches the
    // regex instead of a sane example like "user@example.com". Stripping
    // the pattern for email-formatted fields leaves `format` for real
    // validation tooling and lets Swagger UI fall back to a normal example.
    transform: createJsonSchemaTransform({
      zodToJsonConfig: {
        override: (ctx) => {
          if (ctx.jsonSchema.format === 'email') {
            delete ctx.jsonSchema.pattern;
          }
        },
      },
    }),
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
  });
});
