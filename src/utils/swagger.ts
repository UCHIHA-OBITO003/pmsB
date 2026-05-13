// Avoid loading large third-party type graphs during low-memory builds.
const swaggerJsdoc: (options: any) => any = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Engineering Execution Platform API',
      version: '1.0.0',
      description: 'Internal Delivery OS — AI-Powered Engineering Intelligence Platform',
    },
    servers: [{ url: 'http://localhost:3001', description: 'Development' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
