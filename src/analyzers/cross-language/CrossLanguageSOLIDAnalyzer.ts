/**
 * Cross-Language SOLID Analyzer
 * Enhanced SOLID principle analysis that works across multiple languages
 * using the cross-language entity model
 */

import { CrossLanguageEntity, CrossReference } from '../../types/crossLanguage.js';
import { Violation } from '../../types.js';

export interface CrossLanguageSOLIDConfig {
  maxResponsibilities: number;
  maxDependencies: number;
  maxInterfaceMembers: number;
  maxComplexity: number;
  maxParameters: number;
  checkAbstractions: boolean;
  checkPolymorphism: boolean;
  enableCrossLanguageAnalysis: boolean;
  minCrossLanguageViolationConfidence: number;
}

export interface CrossLanguageSOLIDViolation extends Violation {
  principle: 'SRP' | 'OCP' | 'LSP' | 'ISP' | 'DIP';
  entityId: string;
  entityName: string;
  entityType: string;
  language: string;
  crossLanguageIssue: boolean;
  relatedEntities?: Array<{
    id: string;
    name: string;
    language: string;
    relationship: string;
  }>;
  responsibilityCount?: number;
  dependencyCount?: number;
  memberCount?: number;
  confidence: number;
}

export class CrossLanguageSOLIDAnalyzer {
  private config: CrossLanguageSOLIDConfig;

  constructor(config: Partial<CrossLanguageSOLIDConfig> = {}) {
    this.config = {
      maxResponsibilities: 3,
      maxDependencies: 5,
      maxInterfaceMembers: 7,
      maxComplexity: 10,
      maxParameters: 5,
      checkAbstractions: true,
      checkPolymorphism: true,
      enableCrossLanguageAnalysis: true,
      minCrossLanguageViolationConfidence: 0.7,
      ...config
    };
  }

  /**
   * Analyze SOLID principles across multiple languages
   */
  async analyze(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    console.log(`[CrossLanguageSOLIDAnalyzer] Analyzing ${entities.length} entities across languages`);

    const violations: CrossLanguageSOLIDViolation[] = [];

    // Standard SOLID analysis per entity
    violations.push(...await this.analyzeSingleResponsibility(entities, references));
    violations.push(...await this.analyzeOpenClosed(entities, references));
    violations.push(...await this.analyzeLiskovSubstitution(entities, references));
    violations.push(...await this.analyzeInterfaceSegregation(entities, references));
    violations.push(...await this.analyzeDependencyInversion(entities, references));

    // Cross-language specific SOLID violations
    if (this.config.enableCrossLanguageAnalysis) {
      violations.push(...await this.analyzeCrossLanguageSOLID(entities, references));
    }

    console.log(`[CrossLanguageSOLIDAnalyzer] Found ${violations.length} SOLID violations`);
    return violations;
  }

  /**
   * Single Responsibility Principle - Enhanced for cross-language
   */
  private async analyzeSingleResponsibility(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    const violations: CrossLanguageSOLIDViolation[] = [];

    for (const entity of entities) {
      const responsibilities = this.countResponsibilities(entity, references, entities);
      
      if (responsibilities.count > this.config.maxResponsibilities) {
        violations.push({
          file: entity.file,
          line: entity.startLine || 0,
          severity: responsibilities.count > this.config.maxResponsibilities * 2 ? 'critical' : 'warning',
          message: `${entity.type} '${entity.name}' has too many responsibilities (${responsibilities.count}) across ${responsibilities.languages.size} languages`,
          principle: 'SRP',
          entityId: entity.id,
          entityName: entity.name,
          entityType: entity.type,
          language: entity.language,
          crossLanguageIssue: responsibilities.languages.size > 1,
          responsibilityCount: responsibilities.count,
          confidence: responsibilities.confidence,
          relatedEntities: responsibilities.relatedEntities,
          details: {
            responsibilities: responsibilities.count,
            maxAllowed: this.config.maxResponsibilities,
            languagesInvolved: Array.from(responsibilities.languages),
            crossLanguageFactors: responsibilities.crossLanguageFactors
          },
          suggestion: this.generateSRPSuggestion(entity, responsibilities),
          analyzer: 'cross-language-solid',
          category: 'single-responsibility'
        });
      }
    }

    return violations;
  }

  /**
   * Open/Closed Principle - Cross-language switch detection
   */
  private async analyzeOpenClosed(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    const violations: CrossLanguageSOLIDViolation[] = [];

    if (!this.config.checkPolymorphism) return violations;

    for (const entity of entities) {
      const polymorphismOpportunities = this.detectPolymorphismOpportunities(entity, references, entities);
      
      if (polymorphismOpportunities.confidence > 0.6) {
        violations.push({
          file: entity.file,
          line: entity.startLine || 0,
          severity: 'suggestion',
          message: `${entity.type} '${entity.name}' shows patterns that could benefit from polymorphism across ${polymorphismOpportunities.languages.size} languages`,
          principle: 'OCP',
          entityId: entity.id,
          entityName: entity.name,
          entityType: entity.type,
          language: entity.language,
          crossLanguageIssue: polymorphismOpportunities.languages.size > 1,
          confidence: polymorphismOpportunities.confidence,
          relatedEntities: polymorphismOpportunities.relatedEntities,
          details: {
            patterns: polymorphismOpportunities.patterns,
            languagesInvolved: Array.from(polymorphismOpportunities.languages),
            complexityScore: polymorphismOpportunities.complexityScore
          },
          suggestion: this.generateOCPSuggestion(entity, polymorphismOpportunities),
          analyzer: 'cross-language-solid',
          category: 'open-closed'
        });
      }
    }

    return violations;
  }

  /**
   * Liskov Substitution Principle - Cross-language inheritance analysis
   */
  private async analyzeLiskovSubstitution(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    const violations: CrossLanguageSOLIDViolation[] = [];

    const hierarchies = this.findCrossLanguageHierarchies(entities, references);
    
    for (const hierarchy of hierarchies) {
      const lspViolations = this.analyzeHierarchyForLSP(hierarchy, entities);
      violations.push(...lspViolations);
    }

    return violations;
  }

  /**
   * Interface Segregation Principle - Cross-language interface analysis
   */
  private async analyzeInterfaceSegregation(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    const violations: CrossLanguageSOLIDViolation[] = [];

    const interfaces = entities.filter(e => e.type === 'interface');
    
    for (const interfaceEntity of interfaces) {
      const usage = this.analyzeInterfaceUsage(interfaceEntity, references, entities);
      
      if (usage.memberCount > this.config.maxInterfaceMembers) {
        violations.push({
          file: interfaceEntity.file,
          line: interfaceEntity.startLine || 0,
          severity: 'warning',
          message: `Interface '${interfaceEntity.name}' has ${usage.memberCount} members used across ${usage.languages.size} languages`,
          principle: 'ISP',
          entityId: interfaceEntity.id,
          entityName: interfaceEntity.name,
          entityType: interfaceEntity.type,
          language: interfaceEntity.language,
          crossLanguageIssue: usage.languages.size > 1,
          memberCount: usage.memberCount,
          confidence: usage.confidence,
          relatedEntities: usage.implementers,
          details: {
            memberCount: usage.memberCount,
            maxAllowed: this.config.maxInterfaceMembers,
            implementerLanguages: Array.from(usage.languages),
            unusedMembers: usage.unusedMembers
          },
          suggestion: this.generateISPSuggestion(interfaceEntity, usage),
          analyzer: 'cross-language-solid',
          category: 'interface-segregation'
        });
      }
    }

    return violations;
  }

  /**
   * Dependency Inversion Principle - Cross-language abstraction analysis
   */
  private async analyzeDependencyInversion(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    const violations: CrossLanguageSOLIDViolation[] = [];

    if (!this.config.checkAbstractions) return violations;

    for (const entity of entities) {
      if (entity.type === 'class' || entity.type === 'struct' || entity.type === 'service') {
        const dependencies = this.analyzeDependencies(entity, references, entities);
        
        if (dependencies.concreteCount > this.config.maxDependencies) {
          violations.push({
            file: entity.file,
            line: entity.startLine || 0,
            severity: 'suggestion',
            message: `${entity.type} '${entity.name}' depends on ${dependencies.concreteCount} concrete types across ${dependencies.languages.size} languages`,
            principle: 'DIP',
            entityId: entity.id,
            entityName: entity.name,
            entityType: entity.type,
            language: entity.language,
            crossLanguageIssue: dependencies.languages.size > 1,
            dependencyCount: dependencies.concreteCount,
            confidence: dependencies.confidence,
            relatedEntities: dependencies.concreteDependencies,
            details: {
              concreteCount: dependencies.concreteCount,
              abstractCount: dependencies.abstractCount,
              maxAllowed: this.config.maxDependencies,
              languagesInvolved: Array.from(dependencies.languages)
            },
            suggestion: this.generateDIPSuggestion(entity, dependencies),
            analyzer: 'cross-language-solid',
            category: 'dependency-inversion'
          });
        }
      }
    }

    return violations;
  }

  /**
   * Cross-Language specific SOLID violations
   */
  private async analyzeCrossLanguageSOLID(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<CrossLanguageSOLIDViolation[]> {
    const violations: CrossLanguageSOLIDViolation[] = [];

    // Detect API boundary violations
    violations.push(...this.detectAPIBoundaryViolations(entities, references));
    
    // Detect cross-language responsibility leakage
    violations.push(...this.detectResponsibilityLeakage(entities, references));
    
    // Detect distributed interface violations
    violations.push(...this.detectDistributedInterfaceViolations(entities, references));

    return violations;
  }

  /**
   * Count responsibilities considering cross-language factors
   */
  private countResponsibilities(
    entity: CrossLanguageEntity, 
    references: CrossReference[], 
    allEntities: CrossLanguageEntity[]
  ): {
    count: number;
    confidence: number;
    languages: Set<string>;
    relatedEntities: Array<{ id: string; name: string; language: string; relationship: string }>;
    crossLanguageFactors: string[];
  } {
    let count = 1; // Base responsibility
    const languages = new Set([entity.language]);
    const relatedEntities: Array<{ id: string; name: string; language: string; relationship: string }> = [];
    const crossLanguageFactors: string[] = [];

    // Parameter complexity
    if (entity.parameters && entity.parameters.length > this.config.maxParameters) {
      count++;
      crossLanguageFactors.push('excessive-parameters');
    }

    // Complexity factor
    if (entity.complexity && entity.complexity > this.config.maxComplexity) {
      count += Math.floor(entity.complexity / this.config.maxComplexity);
      crossLanguageFactors.push('high-complexity');
    }

    // Cross-language calls
    const outgoingRefs = references.filter(ref => ref.sourceId === entity.id);
    const targetLanguages = new Set(outgoingRefs.map(ref => ref.targetLanguage));
    
    for (const targetLang of targetLanguages) {
      if (targetLang !== entity.language) {
        languages.add(targetLang);
        count++;
        crossLanguageFactors.push('cross-language-dependency');
      }
    }

    // API responsibilities
    if (entity.apiEndpoint) {
      count++;
      crossLanguageFactors.push('api-endpoint');
    }

    // Service boundaries
    if (entity.type === 'service' && outgoingRefs.length > 3) {
      count++;
      crossLanguageFactors.push('service-orchestration');
    }

    // Collect related entities
    for (const ref of outgoingRefs) {
      const target = allEntities.find(e => e.id === ref.targetId);
      if (target && target.language !== entity.language) {
        relatedEntities.push({
          id: target.id,
          name: target.name,
          language: target.language,
          relationship: ref.type
        });
      }
    }

    const confidence = Math.min(1.0, 0.5 + (crossLanguageFactors.length * 0.1));

    return { count, confidence, languages, relatedEntities, crossLanguageFactors };
  }

  /**
   * Detect polymorphism opportunities across languages
   */
  private detectPolymorphismOpportunities(
    entity: CrossLanguageEntity, 
    references: CrossReference[], 
    allEntities: CrossLanguageEntity[]
  ): {
    confidence: number;
    languages: Set<string>;
    patterns: string[];
    complexityScore: number;
    relatedEntities: Array<{ id: string; name: string; language: string; relationship: string }>;
  } {
    const languages = new Set([entity.language]);
    const patterns: string[] = [];
    let complexityScore = 0;
    const relatedEntities: Array<{ id: string; name: string; language: string; relationship: string }> = [];

    // High complexity suggests switch-like patterns
    if (entity.complexity && entity.complexity > 15) {
      complexityScore += entity.complexity;
      patterns.push('high-complexity');
    }

    // Multiple dependencies to similar types across languages
    const outgoingRefs = references.filter(ref => ref.sourceId === entity.id);
    const targetsByLanguage = new Map<string, number>();

    for (const ref of outgoingRefs) {
      const target = allEntities.find(e => e.id === ref.targetId);
      if (target) {
        languages.add(target.language);
        targetsByLanguage.set(target.language, (targetsByLanguage.get(target.language) || 0) + 1);
        
        if (target.language !== entity.language) {
          relatedEntities.push({
            id: target.id,
            name: target.name,
            language: target.language,
            relationship: ref.type
          });
        }
      }
    }

    // Multiple targets per language suggests type-based branching
    if (targetsByLanguage.size > 2) {
      patterns.push('multi-language-dispatch');
      complexityScore += targetsByLanguage.size * 5;
    }

    // Function name patterns
    const switchLikeNames = ['handle', 'process', 'convert', 'transform', 'dispatch', 'route'];
    if (switchLikeNames.some(pattern => entity.name.toLowerCase().includes(pattern))) {
      patterns.push('switch-like-naming');
      complexityScore += 10;
    }

    const confidence = Math.min(1.0, complexityScore / 50);

    return { confidence, languages, patterns, complexityScore, relatedEntities };
  }

  /**
   * Find cross-language inheritance hierarchies
   */
  private findCrossLanguageHierarchies(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Array<{
    entities: CrossLanguageEntity[];
    languages: Set<string>;
    relationships: CrossReference[];
  }> {
    const hierarchies: Array<{
      entities: CrossLanguageEntity[];
      languages: Set<string>;
      relationships: CrossReference[];
    }> = [];

    const processed = new Set<string>();

    for (const entity of entities) {
      if (processed.has(entity.id)) continue;

      const inheritance = references.filter(ref => 
        (ref.sourceId === entity.id || ref.targetId === entity.id) &&
        (ref.type === 'extends' || ref.type === 'implements')
      );

      if (inheritance.length > 0) {
        const hierarchyEntities = this.buildHierarchy(entity, inheritance, entities);
        const languages = new Set(hierarchyEntities.map(e => e.language));
        
        if (languages.size > 1) { // Cross-language hierarchy
          hierarchies.push({
            entities: hierarchyEntities,
            languages,
            relationships: inheritance
          });
          
          hierarchyEntities.forEach(e => processed.add(e.id));
        }
      }
    }

    return hierarchies;
  }

  /**
   * Build hierarchy from inheritance relationships
   */
  private buildHierarchy(
    startEntity: CrossLanguageEntity,
    inheritanceRefs: CrossReference[],
    allEntities: CrossLanguageEntity[]
  ): CrossLanguageEntity[] {
    const entities = new Set<CrossLanguageEntity>();
    const visited = new Set<string>();

    const traverse = (entityId: string) => {
      if (visited.has(entityId)) return;
      visited.add(entityId);

      const entity = allEntities.find(e => e.id === entityId);
      if (!entity) return;

      entities.add(entity);

      // Find related inheritance relationships
      const related = inheritanceRefs.filter(ref => 
        ref.sourceId === entityId || ref.targetId === entityId
      );

      for (const ref of related) {
        const relatedId = ref.sourceId === entityId ? ref.targetId : ref.sourceId;
        traverse(relatedId);
      }
    };

    traverse(startEntity.id);
    return Array.from(entities);
  }

  /**
   * Analyze hierarchy for LSP violations
   */
  private analyzeHierarchyForLSP(
    hierarchy: {
      entities: CrossLanguageEntity[];
      languages: Set<string>;
      relationships: CrossReference[];
    },
    allEntities: CrossLanguageEntity[]
  ): CrossLanguageSOLIDViolation[] {
    const violations: CrossLanguageSOLIDViolation[] = [];

    // Cross-language LSP is particularly challenging
    for (const entity of hierarchy.entities) {
      const parentRefs = hierarchy.relationships.filter(ref => 
        ref.sourceId === entity.id && (ref.type === 'extends' || ref.type === 'implements')
      );

      for (const ref of parentRefs) {
        const parent = allEntities.find(e => e.id === ref.targetId);
        
        if (parent && parent.language !== entity.language) {
          // Cross-language inheritance is risky for LSP
          violations.push({
            file: entity.file,
            line: entity.startLine || 0,
            severity: 'warning',
            message: `${entity.type} '${entity.name}' (${entity.language}) inherits from ${parent.name} (${parent.language}), creating cross-language LSP risks`,
            principle: 'LSP',
            entityId: entity.id,
            entityName: entity.name,
            entityType: entity.type,
            language: entity.language,
            crossLanguageIssue: true,
            confidence: 0.8,
            relatedEntities: [{
              id: parent.id,
              name: parent.name,
              language: parent.language,
              relationship: ref.type
            }],
            details: {
              parentLanguage: parent.language,
              childLanguage: entity.language,
              relationshipType: ref.type
            },
            suggestion: 'Consider using composition or adapter patterns instead of cross-language inheritance',
            analyzer: 'cross-language-solid',
            category: 'liskov-substitution'
          });
        }
      }
    }

    return violations;
  }

  /**
   * Analyze interface usage across languages
   */
  private analyzeInterfaceUsage(
    interfaceEntity: CrossLanguageEntity,
    references: CrossReference[],
    allEntities: CrossLanguageEntity[]
  ): {
    memberCount: number;
    confidence: number;
    languages: Set<string>;
    implementers: Array<{ id: string; name: string; language: string; relationship: string }>;
    unusedMembers: string[];
  } {
    const languages = new Set([interfaceEntity.language]);
    const implementers: Array<{ id: string; name: string; language: string; relationship: string }> = [];
    
    // Find implementers
    const implementationRefs = references.filter(ref => 
      ref.targetId === interfaceEntity.id && ref.type === 'implements'
    );

    for (const ref of implementationRefs) {
      const implementer = allEntities.find(e => e.id === ref.sourceId);
      if (implementer) {
        languages.add(implementer.language);
        implementers.push({
          id: implementer.id,
          name: implementer.name,
          language: implementer.language,
          relationship: 'implements'
        });
      }
    }

    // Count members (simplified)
    const memberCount = interfaceEntity.parameters?.length || 
                       interfaceEntity.metadata?.methodCount || 
                       interfaceEntity.metadata?.memberCount || 0;

    // TODO: Analyze actual usage to find unused members
    const unusedMembers: string[] = [];

    const confidence = languages.size > 1 ? 0.9 : 0.7;

    return { memberCount, confidence, languages, implementers, unusedMembers };
  }

  /**
   * Analyze dependencies for DIP violations
   */
  private analyzeDependencies(
    entity: CrossLanguageEntity,
    references: CrossReference[],
    allEntities: CrossLanguageEntity[]
  ): {
    concreteCount: number;
    abstractCount: number;
    confidence: number;
    languages: Set<string>;
    concreteDependencies: Array<{ id: string; name: string; language: string; relationship: string }>;
  } {
    const languages = new Set([entity.language]);
    const concreteDependencies: Array<{ id: string; name: string; language: string; relationship: string }> = [];
    let concreteCount = 0;
    let abstractCount = 0;

    const outgoingRefs = references.filter(ref => ref.sourceId === entity.id);

    for (const ref of outgoingRefs) {
      const target = allEntities.find(e => e.id === ref.targetId);
      if (!target) continue;

      languages.add(target.language);

      if (this.isConcreteType(target)) {
        concreteCount++;
        concreteDependencies.push({
          id: target.id,
          name: target.name,
          language: target.language,
          relationship: ref.type
        });
      } else {
        abstractCount++;
      }
    }

    const confidence = languages.size > 1 ? 0.9 : 0.7;

    return { concreteCount, abstractCount, confidence, languages, concreteDependencies };
  }

  /**
   * Check if entity is concrete type
   */
  private isConcreteType(entity: CrossLanguageEntity): boolean {
    if (entity.type === 'interface') return false;
    
    switch (entity.language) {
      case 'typescript':
        return !entity.metadata?.isAbstract;
      case 'go':
        return entity.type === 'struct';
      case 'java':
      case 'csharp':
        return !entity.metadata?.isAbstract && entity.type === 'class';
      default:
        return entity.type === 'class' || entity.type === 'struct';
    }
  }

  /**
   * Detect API boundary violations
   */
  private detectAPIBoundaryViolations(
    entities: CrossLanguageEntity[],
    references: CrossReference[]
  ): CrossLanguageSOLIDViolation[] {
    const violations: CrossLanguageSOLIDViolation[] = [];

    const apiEntities = entities.filter(e => e.apiEndpoint);
    
    for (const apiEntity of apiEntities) {
      const callers = references.filter(ref => ref.targetId === apiEntity.id && ref.type === 'api-call');
      const callerLanguages = new Set(callers.map(ref => ref.sourceLanguage));

      if (callerLanguages.size > 2) {
        // API called from many languages - potential SRP violation
        violations.push({
          file: apiEntity.file,
          line: apiEntity.startLine || 0,
          severity: 'suggestion',
          message: `API endpoint '${apiEntity.name}' is called from ${callerLanguages.size} different languages, suggesting multiple responsibilities`,
          principle: 'SRP',
          entityId: apiEntity.id,
          entityName: apiEntity.name,
          entityType: apiEntity.type,
          language: apiEntity.language,
          crossLanguageIssue: true,
          confidence: 0.8,
          details: {
            callerLanguages: Array.from(callerLanguages),
            callCount: callers.length
          },
          suggestion: 'Consider splitting this API into more focused, single-purpose endpoints',
          analyzer: 'cross-language-solid',
          category: 'single-responsibility'
        });
      }
    }

    return violations;
  }

  /**
   * Detect responsibility leakage across languages
   */
  private detectResponsibilityLeakage(
    entities: CrossLanguageEntity[],
    references: CrossReference[]
  ): CrossLanguageSOLIDViolation[] {
    const violations: CrossLanguageSOLIDViolation[] = [];

    // Look for entities that have too many cross-language dependencies
    for (const entity of entities) {
      const outgoingRefs = references.filter(ref => ref.sourceId === entity.id);
      const crossLangRefs = outgoingRefs.filter(ref => ref.targetLanguage !== entity.language);
      
      if (crossLangRefs.length > 3) {
        violations.push({
          file: entity.file,
          line: entity.startLine || 0,
          severity: 'warning',
          message: `${entity.type} '${entity.name}' has dependencies across ${new Set(crossLangRefs.map(r => r.targetLanguage)).size} different languages`,
          principle: 'SRP',
          entityId: entity.id,
          entityName: entity.name,
          entityType: entity.type,
          language: entity.language,
          crossLanguageIssue: true,
          confidence: 0.8,
          details: {
            crossLanguageDependencies: crossLangRefs.length,
            targetLanguages: Array.from(new Set(crossLangRefs.map(r => r.targetLanguage)))
          },
          suggestion: 'Consider using a service layer or adapter pattern to reduce cross-language coupling',
          analyzer: 'cross-language-solid',
          category: 'single-responsibility'
        });
      }
    }

    return violations;
  }

  /**
   * Detect distributed interface violations
   */
  private detectDistributedInterfaceViolations(
    entities: CrossLanguageEntity[],
    references: CrossReference[]
  ): CrossLanguageSOLIDViolation[] {
    const violations: CrossLanguageSOLIDViolation[] = [];

    // Look for interfaces implemented across multiple languages
    const interfaces = entities.filter(e => e.type === 'interface');
    
    for (const iface of interfaces) {
      const implementations = references.filter(ref => 
        ref.targetId === iface.id && ref.type === 'implements'
      );
      
      const implLanguages = new Set(implementations.map(ref => ref.sourceLanguage));
      
      if (implLanguages.size > 1) {
        violations.push({
          file: iface.file,
          line: iface.startLine || 0,
          severity: 'suggestion',
          message: `Interface '${iface.name}' is implemented across ${implLanguages.size} different languages`,
          principle: 'ISP',
          entityId: iface.id,
          entityName: iface.name,
          entityType: iface.type,
          language: iface.language,
          crossLanguageIssue: true,
          confidence: 0.7,
          details: {
            implementationLanguages: Array.from(implLanguages),
            implementationCount: implementations.length
          },
          suggestion: 'Consider language-specific interface definitions or use protocol-based contracts',
          analyzer: 'cross-language-solid',
          category: 'interface-segregation'
        });
      }
    }

    return violations;
  }

  // Suggestion generators (enhanced for cross-language)

  private generateSRPSuggestion(
    entity: CrossLanguageEntity, 
    responsibilities: any
  ): string {
    const baseSuggestion = `Consider breaking ${entity.name} into smaller, more focused components`;
    
    if (responsibilities.crossLanguageFactors.includes('cross-language-dependency')) {
      return `${baseSuggestion}. Use service layers or adapters to isolate cross-language concerns.`;
    }
    
    if (responsibilities.crossLanguageFactors.includes('api-endpoint')) {
      return `${baseSuggestion}. Split API endpoints by business domain or operation type.`;
    }
    
    return `${baseSuggestion}. Apply the Single Responsibility Principle within and across language boundaries.`;
  }

  private generateOCPSuggestion(
    entity: CrossLanguageEntity, 
    opportunities: any
  ): string {
    if (opportunities.languages.size > 1) {
      return `Consider using cross-language polymorphism through well-defined interfaces or protocol contracts. Use dependency injection across service boundaries.`;
    }
    
    return `Consider using polymorphism (interfaces/inheritance) instead of conditional logic. Use the Strategy or Command patterns.`;
  }

  private generateISPSuggestion(
    entity: CrossLanguageEntity, 
    usage: any
  ): string {
    if (usage.languages.size > 1) {
      return `Split this interface into language-specific or role-specific contracts. Consider using protocol buffers or OpenAPI specifications for cross-language interfaces.`;
    }
    
    return `Split this interface into smaller, more focused interfaces that serve specific client needs.`;
  }

  private generateDIPSuggestion(
    entity: CrossLanguageEntity, 
    dependencies: any
  ): string {
    if (dependencies.languages.size > 1) {
      return `Use dependency injection and abstraction layers to reduce coupling across language boundaries. Consider service meshes or API gateways for cross-language dependencies.`;
    }
    
    return `Depend on abstractions (interfaces) rather than concrete implementations. Use dependency injection containers.`;
  }
}