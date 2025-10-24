import React, { useState, useEffect, useCallback, useMemo, useRef, useContext } from 'react';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { useQuery, useMutation } from '@apollo/client';
import { FormContext } from './contexts/FormContext';
import * as yup from 'yup';

// Edge Case 1: Legitimate complex form with many hooks
// This should be recognized as a Form pattern and not trigger false positives
export const EmployeeOnboardingForm: React.FC = () => {
  // Form state management - all related to form handling
  const { register, handleSubmit, control, watch, setValue, getValues, formState } = useForm({
    defaultValues: {
      personalInfo: {},
      employment: {},
      benefits: {},
      emergency: [],
      documents: []
    }
  });

  // Field arrays for dynamic form sections
  const { fields: emergencyFields, append: appendEmergency, remove: removeEmergency } = useFieldArray({
    control,
    name: 'emergency'
  });
  
  const { fields: documentFields, append: appendDocument, remove: removeDocument } = useFieldArray({
    control,
    name: 'documents'
  });

  // Form context
  const { validationRules, submitEndpoint } = useContext(FormContext);

  // Watch specific fields for conditional rendering
  const employmentType = useWatch({ control, name: 'employment.type' });
  const hasDependent = useWatch({ control, name: 'benefits.hasDependent' });
  const country = useWatch({ control, name: 'personalInfo.country' });

  // Local UI state for form sections
  const [activeSection, setActiveSection] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [validationErrors, setValidationErrors] = useState({});

  // Refs for form navigation
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Computed values for form logic
  const completionPercentage = useMemo(() => {
    const values = getValues();
    const totalFields = Object.keys(values).length;
    const filledFields = Object.values(values).filter(v => v !== '' && v !== null).length;
    return Math.round((filledFields / totalFields) * 100);
  }, [getValues]);

  const isInternational = useMemo(() => {
    return country && country !== 'USA';
  }, [country]);

  // Form validation schema based on employment type
  const validationSchema = useMemo(() => {
    return yup.object().shape({
      personalInfo: yup.object().shape({
        firstName: yup.string().required('First name is required'),
        lastName: yup.string().required('Last name is required'),
        email: yup.string().email('Invalid email').required('Email is required'),
        // Dynamic validation based on country
        ...(isInternational && {
          passport: yup.string().required('Passport is required for international employees')
        })
      }),
      employment: yup.object().shape({
        type: yup.string().required('Employment type is required'),
        // Conditional validation based on employment type
        ...(employmentType === 'contractor' && {
          contractEndDate: yup.date().required('Contract end date is required')
        })
      })
    });
  }, [employmentType, isInternational]);

  // Form submission handler
  const handleFormSubmit = useCallback(async (data: any) => {
    try {
      // Validate against schema
      await validationSchema.validate(data, { abortEarly: false });
      
      // Transform data for submission
      const transformedData = {
        ...data,
        submittedAt: new Date().toISOString(),
        completionPercentage
      };

      // Submit to endpoint
      const response = await fetch(submitEndpoint, {
        method: 'POST',
        body: JSON.stringify(transformedData)
      });

      if (!response.ok) throw new Error('Submission failed');
      
      // Success handling
      console.log('Form submitted successfully');
    } catch (error) {
      if (error.name === 'ValidationError') {
        setValidationErrors(error.errors);
      }
      console.error('Form submission error:', error);
    }
  }, [validationSchema, completionPercentage, submitEndpoint]);

  // Auto-save functionality
  useEffect(() => {
    const autoSaveTimer = setInterval(() => {
      const formData = getValues();
      localStorage.setItem('onboarding-draft', JSON.stringify(formData));
    }, 30000); // Auto-save every 30 seconds

    return () => clearInterval(autoSaveTimer);
  }, [getValues]);

  // Load saved draft on mount
  useEffect(() => {
    const savedDraft = localStorage.getItem('onboarding-draft');
    if (savedDraft) {
      const draftData = JSON.parse(savedDraft);
      Object.keys(draftData).forEach(key => {
        setValue(key, draftData[key]);
      });
    }
  }, [setValue]);

  // Section navigation handler
  const navigateToSection = useCallback((index: number) => {
    setActiveSection(index);
    sectionRefs.current[index]?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // File upload handler
  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        appendDocument({
          name: file.name,
          size: file.size,
          type: file.type,
          uploadedAt: new Date()
        });
      });
    }
  }, [appendDocument]);

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="onboarding-form">
      <div className="form-progress">
        <div className="progress-bar" style={{ width: `${completionPercentage}%` }} />
        <span>{completionPercentage}% Complete</span>
      </div>

      <div className="form-navigation">
        {['Personal', 'Employment', 'Benefits', 'Emergency', 'Documents'].map((section, index) => (
          <button
            key={section}
            type="button"
            onClick={() => navigateToSection(index)}
            className={activeSection === index ? 'active' : ''}
          >
            {section}
          </button>
        ))}
      </div>

      {/* Personal Information Section */}
      <div ref={el => sectionRefs.current[0] = el} className="form-section">
        <h2>Personal Information</h2>
        <input {...register('personalInfo.firstName')} placeholder="First Name" />
        <input {...register('personalInfo.lastName')} placeholder="Last Name" />
        <input {...register('personalInfo.email')} placeholder="Email" />
        <select {...register('personalInfo.country')}>
          <option value="">Select Country</option>
          <option value="USA">United States</option>
          <option value="CAN">Canada</option>
          <option value="MEX">Mexico</option>
        </select>
        {isInternational && (
          <input {...register('personalInfo.passport')} placeholder="Passport Number" />
        )}
      </div>

      {/* Employment Section */}
      <div ref={el => sectionRefs.current[1] = el} className="form-section">
        <h2>Employment Details</h2>
        <select {...register('employment.type')}>
          <option value="">Select Type</option>
          <option value="fulltime">Full Time</option>
          <option value="contractor">Contractor</option>
          <option value="intern">Intern</option>
        </select>
        {employmentType === 'contractor' && (
          <input {...register('employment.contractEndDate')} type="date" />
        )}
      </div>

      {/* Benefits Section */}
      <div ref={el => sectionRefs.current[2] = el} className="form-section">
        <h2>Benefits Selection</h2>
        <label>
          <input {...register('benefits.hasDependent')} type="checkbox" />
          Do you have dependents?
        </label>
        {hasDependent && (
          <div className="dependent-info">
            <input {...register('benefits.dependentCount')} type="number" placeholder="Number of dependents" />
          </div>
        )}
      </div>

      {/* Emergency Contacts */}
      <div ref={el => sectionRefs.current[3] = el} className="form-section">
        <h2>Emergency Contacts</h2>
        {emergencyFields.map((field, index) => (
          <div key={field.id} className="emergency-contact">
            <input {...register(`emergency.${index}.name`)} placeholder="Contact Name" />
            <input {...register(`emergency.${index}.phone`)} placeholder="Phone Number" />
            <button type="button" onClick={() => removeEmergency(index)}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => appendEmergency({ name: '', phone: '' })}>
          Add Emergency Contact
        </button>
      </div>

      {/* Documents */}
      <div ref={el => sectionRefs.current[4] = el} className="form-section">
        <h2>Document Upload</h2>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileUpload}
          accept=".pdf,.doc,.docx"
        />
        {documentFields.map((doc, index) => (
          <div key={doc.id} className="document-item">
            <span>{doc.name}</span>
            <button type="button" onClick={() => removeDocument(index)}>Remove</button>
          </div>
        ))}
      </div>

      {/* Form Actions */}
      <div className="form-actions">
        <button type="button" onClick={() => setShowPreview(!showPreview)}>
          {showPreview ? 'Hide' : 'Show'} Preview
        </button>
        <button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? 'Submitting...' : 'Submit Application'}
        </button>
      </div>

      {/* Validation Errors */}
      {validationErrors.length > 0 && (
        <div className="validation-errors">
          {validationErrors.map((error, index) => (
            <div key={index} className="error">{error}</div>
          ))}
        </div>
      )}
    </form>
  );
};