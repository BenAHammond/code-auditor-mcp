// Test file to verify unused import detection in DRY analyzer
import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import * as crypto from 'crypto';
import path from 'path';
import { readFile } from 'fs/promises';
import type { User } from './types';
import _ from 'lodash';

// Only using format, all others should be reported as unused
export function testFunction() {
  const formattedDate = format(new Date(), 'yyyy-MM-dd');
  return formattedDate;
}