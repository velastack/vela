import { describe, expect, test } from 'vitest';
import { defaultForcePathStyle } from './s3-settings.ts';

describe('defaultForcePathStyle', () => {
	test.each([
		'https://s3.amazonaws.com',
		'https://s3.us-west-2.amazonaws.com',
		'https://abc123.r2.cloudflarestorage.com'
	])('is off for %s, which addresses buckets as a subdomain', (endpoint) => {
		expect(defaultForcePathStyle(endpoint)).toBe(false);
	});

	test.each([
		'http://localhost:9000',
		'https://minio.example.com',
		'https://s3.garage.internal',
		'https://us-east-1.linodeobjects.com'
	])('is on for %s, which needs the bucket in the path', (endpoint) => {
		expect(defaultForcePathStyle(endpoint)).toBe(true);
	});

	test('does not throw on something that is not a URL', () => {
		expect(defaultForcePathStyle('not a url')).toBe(false);
	});

	test('is not fooled by a hostname that merely contains the provider', () => {
		expect(defaultForcePathStyle('https://amazonaws.com.evil.example')).toBe(true);
	});
});
